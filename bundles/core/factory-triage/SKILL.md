---
name: factory-triage
description: Triage the lesson candidates queued for this source repo. Cluster them into lesson families, then land one reviewed lesson branch with one commit per cluster. Run it in the repo that owns the skills (core's or a company bundle's). Pass a candidate file for "review now", or nothing for the whole queue.
disable-model-invocation: true
---

# Triage

Downstream sessions hand lessons over as **candidates**. A candidate is one JSON file under `~/.agents/factory/candidates/<core|org>/`. It holds the kind, the skill, a summary, evidence pointers, an optional draft patch, and the `fixedWhen` signal. Triage turns the queue into **clusters**, which are lesson families. Each cluster becomes one commit on one lesson branch, and you review the branch once. A cluster's size is the count that matters: one rule from three sightings beats three rules from one sighting each.

`lessons.mjs` below is `.agents/skills/factory-reflect/scripts/lessons.mjs`. In a bundle's own repo, where core isn't installed, it's `<core bundle>/factory-reflect/scripts/lessons.mjs`.

## 1. Check the home repo and read the queue

```bash
node .agents/skills/factory-context/scripts/resolve.mjs     # project.root, adapters
node <lessons.mjs> queue                                    # per scope: its source repo, candidates, ages
```

Triage only the scopes whose `repo` is this session's repo (`project.root`'s main checkout). A scope owned by another repo is that repo's work. Give its `start` command and `prompt`, then go on.

- **Review now** (you were given a candidate file): take that candidate, plus the queued candidates for the same skill (`queue --skill <its skill>`), because a fix to that file should account for them. Leave the rest for the scheduled run.
- **Whole queue** (no file): every queued candidate for this repo's scopes.

Drop what's already decided. `lessons.mjs known --never` lists the families the user refused. A candidate in one of them goes straight to `done --outcome dropped`.

## 2. Cluster

Read each candidate. Open its evidence when the summary leaves the *why* unclear: grep the transcript for its `grep` words, or read the PR thread. A transcript that no longer exists is fine: the summary and the PR links are enough.

Group candidates that the same edit would fix: the same skill section, the same missing check, the same wrong fact. Similar wording isn't enough. Two candidates belong together when one commit settles both.

Rank the clusters by size (largest first), then by cost: a fact with a draft patch is cheap, and a new check is dear. For each cluster, write:

- a **slug**: the family name, which is also the fingerprint for `never`
- its **members**: the candidate files
- the **edit**: which file changes, and how (a check, a rule, a skill edit, a fact)
- its **fixedWhen**: the members' signals, merged

**Show the clusters with their members before any branch exists.** The user may split, merge or drop a cluster. They may also mark a family `never` (`lessons.mjs decide --fingerprint <slug> --decision never --summary "<one line>" --scope core|org`). If you run as a background subagent, return the clusters and let the caller ask.

## 3. One lesson branch, one commit per cluster

Follow factory-reflect's [Landing a lesson branch](../factory-reflect/SKILL.md#landing-a-lesson-branch), from step 2, with `--slug triage-<YYYY-MM-DD>` (or `triage-<candidate slug>` for review now). For each cluster:

- Make the edit in the worktree. Apply a member's draft patch when it still fits; otherwise write the edit (read `writing-for-agents` first). Prove a check: it must go **red** on the past mistake before it goes green.
- Commit it on its own. The subject is the edit. The body quotes the evidence grep hits, one line each, and ends with trailers: `Candidates:` (the member files' basenames) and `Fixed-when:` (the merged signal).

Then do the landing steps in order: the internal-data screen, the review gate (with the head noted), land, and push. A cluster dropped in review is reverted on the branch before landing: `git rebase --onto` past its commit.

## 4. Close the candidates

After the land, mark each member:

```bash
node <lessons.mjs> done --file <candidate> --outcome landed     # its cluster landed
node <lessons.mjs> done --file <candidate> --outcome dropped    # dropped in step 1, 2 or the review
```

`done` moves the candidate and its draft to `done/`, and keeps them there for 90 days. When the branch stays undecided (the gate was dismissed), leave the candidates queued. The branch's Inbox notice says which candidates wait on it.

## 5. Report

When `adapters.lessonInbox` is `plannotator-inbox`, send one message to the thread `factory lessons`. It names the repo, the clusters with their member counts, what landed and what was dropped, and the candidates still queued. Then give the same summary here, in a few lines.
