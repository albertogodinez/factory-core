// Lines in a feature entry that read as history rather than current truth
// (references/entry-contract.md, "What an entry leaves out").
const PATTERNS = [
  { kind: 'commit SHA', re: /`(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}`|\b(?:as|from|at|on main) (?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/ },
  { kind: 'merge history', re: /\bsquash-merged\b|\bmerged (?:on |as )?\d{4}-\d{2}-\d{2}|\breleased in \d+\.\d+/i },
  { kind: 'Slack thread or comment id', re: /\b\d{10}\.\d{6}\b|\bdiscussion_r\d+|\breview comment \d{6,}/ },
  { kind: 'PR or ticket status', re: /\b(?:CI green|mergeable|assigned to|assignee)\b/i },
];

/** @param {string} text @returns {{ line: number, kind: string }[]} */
export function historyLines(text) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const { kind, re } of PATTERNS) if (re.test(line)) hits.push({ line: index + 1, kind });
  });
  return hits;
}
