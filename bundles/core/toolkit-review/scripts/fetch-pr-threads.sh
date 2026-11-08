#!/usr/bin/env bash
set -euo pipefail

# fetch-pr-threads.sh <gh-host> <owner/repo> <pr-number> [<marker-text>]
#
# Fetches every review and review comment on one PR and prints a single normalized JSON object
# to stdout. Nothing is filtered: callers apply their own author, path and noise rules.
#
# Callers: toolkit-review (Phase 1 existing-comments fetch, Phase 3 re-review check, Phase 5
# overlap check). Keep this the only place the skill turns a PR's review graph into records.
#
# Output:
# {
#   "pr": { number, title, url, author, updated_at, merged_at, head_ref_oid },
#   "reviews":  [ { review_id, author, author_type, state, body, submitted_at, ours, ours_kind } ],
#   "comments": [ { comment_id, url, path, line, original_line, diff_hunk, body, created_at,
#                   author, author_type, review_id, review_state,
#                   in_reply_to_id, parent_author, parent_author_type, parent_ours,
#                   root_id, thread_resolved, ours, ours_kind } ]
# }
#
# - author logins use REST form: bots end in "[bot]"; author_type is "Bot" or "User".
# - root_id is the thread's first comment; thread_resolved comes from GraphQL reviewThreads.
# - ours is true when the body carries the project's hidden `<!-- <marker-text> {...} -->` marker
#   (toolkit-pr-comment/references/github-pr-comments.md §1; pass the text from adapters.commentMarker);
#   ours_kind is its "kind" (null for replies). With no marker text, ours is always false.
#
# Primary path is one GraphQL request. If reviews or comments exceed 100 nodes it falls back to
# the paginated REST endpoints. Thread resolution is always a separate paginated GraphQL query,
# because REST does not expose it.

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "Usage: fetch-pr-threads.sh <gh-host> <owner/repo> <pr-number> [<marker-text>]" >&2
  exit 1
fi

gh_host="$1"
owner_repo="$2"
pr="$3"
marker="${4:-}"
owner="${owner_repo%%/*}"
repo="${owner_repo#*/}"
export GH_HOST="$gh_host"

graph=$(gh api graphql -F owner="$owner" -F repo="$repo" -F pr="$pr" -f query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      number title url updatedAt mergedAt headRefOid
      author { login __typename }
      reviews(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          databaseId author { login __typename } body state submittedAt
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              databaseId url body path line originalLine diffHunk createdAt
              author { login __typename }
              replyTo { databaseId author { login __typename } }
            }
          }
        }
      }
    }
  }
}')

threads=$(gh api graphql --paginate --slurp -F owner="$owner" -F repo="$repo" -F pr="$pr" -f query='
query($owner: String!, $repo: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}' | jq '[.[].data.repository.pullRequest.reviewThreads.nodes[]
          | {key: (.comments.nodes[0].databaseId | tostring), value: .isResolved}] | from_entries')

paginated=$(jq '.data.repository.pullRequest.reviews as $r
  | ($r.pageInfo.hasNextPage or any($r.nodes[]; .comments.pageInfo.hasNextPage))' <<<"$graph")

if [[ "$paginated" == "true" || "${FETCH_PR_THREADS_FORCE_REST:-}" == "1" ]]; then
  echo "fetch-pr-threads: >100 reviews or comments on ${owner_repo}#${pr}; using paginated REST" >&2
  rest_comments=$(gh api --paginate --slurp "repos/${owner_repo}/pulls/${pr}/comments?per_page=100" | jq 'add // []')
  rest_reviews=$(gh api --paginate --slurp "repos/${owner_repo}/pulls/${pr}/reviews?per_page=100" | jq 'add // []')
  base=$(jq -n --argjson g "$graph" --argjson c "$rest_comments" --argjson r "$rest_reviews" '
    ($g.data.repository.pullRequest) as $p
    | ($r | map({key: (.id|tostring), value: .state}) | from_entries) as $state
    | {
        pr: $p,
        reviews: [ $r[] | {review_id: .id, author: .user.login, author_type: .user.type, state, body, submitted_at} ],
        comments: [ $c[] | {
          comment_id: .id, url: .html_url, path, line, original_line, diff_hunk, body, created_at,
          author: .user.login, author_type: .user.type,
          review_id: .pull_request_review_id, review_state: $state[(.pull_request_review_id|tostring)],
          in_reply_to_id
        } ]
      }')
else
  base=$(jq '
    def login: if .__typename == "Bot" then .login + "[bot]" else .login end;
    def kind: if .__typename == "Bot" then "Bot" else "User" end;
    .data.repository.pullRequest as $p
    | {
        pr: $p,
        reviews: [ $p.reviews.nodes[] | {review_id: .databaseId, author: (.author | login), author_type: (.author | kind), state, body, submitted_at: .submittedAt} ],
        comments: [ $p.reviews.nodes[] as $rv | $rv.comments.nodes[] | {
          comment_id: .databaseId, url, path, line, original_line: .originalLine, diff_hunk: .diffHunk, body, created_at: .createdAt,
          author: (.author | login), author_type: (.author | kind),
          review_id: $rv.databaseId, review_state: $rv.state,
          in_reply_to_id: (.replyTo.databaseId // null)
        } ]
      }' <<<"$graph")
fi

jq --argjson resolved "$threads" --arg marker "$marker" '
  def cc: if $marker == "" then false else (.body // "") | contains("<!-- " + $marker + " ") end;
  def cc_kind: if cc then ((.body | capture("<!-- " + ($marker | gsub("(?<c>[^A-Za-z0-9 ])"; "\\" + .c)) + " (?<j>\\{[^\\n]*\\}) -->").j | fromjson? | .kind) // null) else null end;
  (.comments | map({key: (.comment_id|tostring), value: .}) | from_entries) as $by_id
  | def root($c): if $c.in_reply_to_id == null or ($by_id[($c.in_reply_to_id|tostring)] == null) then $c.comment_id
                  else root($by_id[($c.in_reply_to_id|tostring)]) end;
  {
    pr: (.pr | {number, title, url, author: (if .author.__typename == "Bot" then .author.login + "[bot]" else .author.login end),
                updated_at: .updatedAt, merged_at: .mergedAt, head_ref_oid: .headRefOid}),
    reviews: [ .reviews[] | . + {ours: cc, ours_kind: cc_kind} ],
    comments: [ .comments[] as $c
      | ($by_id[($c.in_reply_to_id // "" | tostring)]) as $parent
      | root($c) as $root
      | $c + {
          parent_author: ($parent.author // null),
          parent_author_type: ($parent.author_type // null),
          parent_ours: (if $parent == null then null else ($parent | cc) end),
          root_id: $root,
          thread_resolved: (($root|tostring) as $k | if $resolved | has($k) then $resolved[$k] else null end),  # not `//`: it treats false as missing
          ours: ($c | cc),
          ours_kind: ($c | cc_kind)
        } ]
  }' <<<"$base"
