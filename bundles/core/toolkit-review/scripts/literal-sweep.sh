#!/usr/bin/env bash
set -euo pipefail

# literal-sweep.sh <diff-file> <output-dir>
# Deterministic grep over the lines a diff ADDS, run before any reviewer interprets the change.
# Writes <output-dir>/sweep.md: one section per signal, each hit as `path:line` plus the line,
# with the personas that own the signal. Hits are places to look, not findings.
# Also writes <output-dir>/sweep-hits.tsv (signal, owners, path, line), the same hits sweep.md
# lists, for check-sweep-coverage.mjs and any pack hook that reads it.
# Generated files, lockfiles and snapshots are skipped.

if [[ $# -lt 2 ]]; then
  echo "Usage: literal-sweep.sh <diff-file> <output-dir>" >&2
  exit 1
fi

diff_file="$1"
out_dir="$2"
out="${out_dir}/sweep.md"
mkdir -p "$out_dir"

# Persona packs extend this table with a sweep-signals.txt in their directory (see the loop
# below the table): full rows add signals, "+id#owners" lines add owners to an existing signal.
# signal id # owning personas # ERE pattern # path filter (ERE; empty = any path) # path exclude (ERE; optional)
# Fields are separated by '#', so patterns may use '|'; write a literal '#' as \043. Patterns are POSIX ERE (no \b).
# read -d '' (not $(cat <<EOF)): bash mis-parses unbalanced parens in a heredoc inside $( ).
read -r -d '' signals <<'EOF' || true
any-cast#typescript-conventions, general# as (any|unknown as)([^A-Za-z0-9_]|$)#\.(ts|tsx)$
non-null#typescript-conventions, general#[]A-Za-z0-9_)]![.)[,;]#\.(ts|tsx)$
suppression#no-comments, typescript-conventions#@ts-(ignore|expect-error|nocheck)|eslint-disable|@(file:)?Suppress(Warnings)?\(|ktlint-disable|noqa|type: *ignore#\.(ts|tsx|js|jsx|kt|kts|java|py)$
coverage-ignore#typescript-conventions#(istanbul|c8|v8) ignore#
use-effect#react-patterns#(^|[^A-Za-z0-9_])useEffect\(#\.(ts|tsx|js|jsx)$
class-selector-in-test#typescript-conventions#querySelector(All)?\(|getElementsByClassName|toHaveClass\(|classList|readFileSync\([^)]*\.css|\.find\(['"]\.#(\.test|\.spec|\.cy)\.(ts|tsx|js|jsx)$|/tests?/
not-to-be-null#typescript-conventions#\.not\.toBeNull\(\)#
clickable-div#general#<(div|span)[^>]*onClick#\.(tsx|jsx)$
debug-leftover#general#console\.(log|debug)\(|(^|[^A-Za-z0-9_])debugger([^A-Za-z0-9_]|$)#
todo#general#(^|[^A-Za-z0-9_])(TODO|FIXME|XXX)([^A-Za-z0-9_]|$)#
added-comment#no-comments#^[[:space:]]*(//|/\*|\*([[:space:]]|/|$)|\043([[:space:]]|$)|<!--|\{/\*)#\.(ts|tsx|js|jsx|kt|kts|java|py|css|scss|sh)$
swallowed-error#fix-root-causes#catch[[:space:]]*(\([^)]*\))?[[:space:]]*\{[[:space:]]*\}|\.catch\(\(\)|except[[:space:]]*(Exception)?[[:space:]]*:|runCatching|getOrNull\(\)|getOrDefault\(#\.(ts|tsx|js|jsx|kt|kts|java|py)$
fallback-default#fix-root-causes#\?\?[[:space:]]*(0|\[\]|\{\}|''|""|false)([^A-Za-z0-9_]|$)|\?:[[:space:]]*(0|emptyList\(\)|emptyMap\(\)|"")#\.(ts|tsx|js|jsx|kt|kts|java|py)$
loose-test-assertion#test-behavior#toHaveBeenCalled(Times)?\(|verify[[:space:]]*(\(|\{)|assert_called|toMatchSnapshot\(|toBeTruthy\(\)|toBeDefined\(\)|isNotNull\(\)#(\.test|\.spec|\.cy)\.(ts|tsx|js|jsx)$|/tests?/|/src/test/|test_[^/]*\.py$
EOF

# Merge each installed pack's sweep-signals.txt. Blank lines and lines starting with ';' are ignored;
# "!id#regex" lines are read by check-sweep-coverage.mjs, not here.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
skills_root="$(cd -- "${script_dir}/../.." && pwd)"
pack_files=()
for f in "${skills_root}"/toolkit-review-*/sweep-signals.txt; do [[ -f "$f" ]] && pack_files+=("$f"); done
if [[ -n "${TOOLKIT_REVIEW_PACKS:-}" ]]; then
  IFS=':' read -r -a extra_packs <<< "$TOOLKIT_REVIEW_PACKS"
  for d in "${extra_packs[@]}"; do [[ -f "$d/sweep-signals.txt" ]] && pack_files+=("$d/sweep-signals.txt"); done
fi
if [[ ${#pack_files[@]} -gt 0 ]]; then
  pack_lines=$(cat "${pack_files[@]}" | grep -vE '^(;|!|[[:space:]]*$)' || true)
  adds=$(printf '%s\n' "$pack_lines" | grep -E '^\+' | sed 's/^+//' || true)
  news=$(printf '%s\n' "$pack_lines" | grep -vE '^\+' || true)
  signals=$(printf '%s\n' "$signals" | ADDS="$adds" awk -F'#' -v OFS='#' '
    BEGIN { n = split(ENVIRON["ADDS"], L, "\n"); for (i = 1; i <= n; i++) if (L[i] != "") { split(L[i], P, "#"); add[P[1]] = add[P[1]] ", " P[2] } }
    $1 in add { $2 = $2 add[$1] } { print }')
  [[ -n "$news" ]] && signals="${signals}"$'\n'"${news}"
fi

# Emit "path<TAB>line<TAB>text" for every added line, tracking head-side line numbers per hunk.
# Generated files, snapshots and lockfiles are skipped.
added=$(awk '
  /^\+\+\+ / { path = substr($0, 5); sub(/^b\//, "", path); skip = (path == "/dev/null" || path ~ /__generated__\/|\.snap$|(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/); next }
  /^--- / { next }
  /^@@ / { match($0, /\+[0-9]+/); line = substr($0, RSTART + 1, RLENGTH - 1) + 0; next }
  /^\+/ { if (!skip) printf "%s\t%d\t%s\n", path, line, substr($0, 2); line++; next }
  /^-/ { next }
  { line++ }
' "$diff_file")

{
  echo "# Literal sweep"
  echo
  echo "Deterministic hits on lines this diff adds. Each is a place to look, not a finding: read the"
  echo "line in context and decide. Read only the sections whose owners include your persona."
  echo
} > "$out"
tsv="${out_dir}/sweep-hits.tsv"
printf 'signal\towners\tpath\tline\n' > "$tsv"

total=0
while IFS='#' read -r id owners pattern filter exclude; do
  [[ -z "$id" ]] && continue
  # Patterns go through ENVIRON, not -v, so awk does not reinterpret their backslashes.
  hits=$(printf '%s\n' "$added" | PAT="$pattern" FILT="$filter" EXCL="$exclude" awk -F'\t' '
    NF >= 3 { t = $0; sub(/^[^\t]*\t[^\t]*\t/, "", t) }
    NF >= 3 && (ENVIRON["FILT"] == "" || $1 ~ ENVIRON["FILT"]) && (ENVIRON["EXCL"] == "" || $1 !~ ENVIRON["EXCL"]) && t ~ ENVIRON["PAT"] {
      gsub(/^[ \t]+/, "", t); printf "- `%s:%s` %s\n", $1, $2, substr(t, 1, 140)
    }')
  [[ -z "$hits" ]] && continue
  count=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
  total=$((total + count))
  {
    echo "## ${id} (${count})"
    echo
    echo "Owners: ${owners}"
    echo
    printf '%s\n' "$hits" | head -40
    [[ "$count" -gt 40 ]] && echo "- … $((count - 40)) more"
    echo
  } >> "$out"
  printf '%s\n' "$hits" | head -40 | sed -E 's/^- `(.*):([0-9]+)`.*$/\1\t\2/' |
    awk -v id="$id" -v own="$owners" -F'\t' '{ printf "%s\t%s\t%s\t%s\n", id, own, $1, $2 }' >> "$tsv"
done <<< "$signals"

[[ "$total" -eq 0 ]] && echo "No hits." >> "$out"
echo "literal sweep: ${total} hits → ${out}" >&2
