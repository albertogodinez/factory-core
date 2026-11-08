// Plan files (<planHome>/*.md, README.md excluded) need frontmatter with title, status, repos and
// created. status is draft | active | completed | abandoned; repos is a non-empty list; created and
// completed are YYYY-MM-DD dates; a completed or abandoned plan carries `completed`.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '../lib.mjs';

export const STATUSES = ['draft', 'active', 'completed', 'abandoned'];

const validDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};

export function checkPlanText(text) {
  const fm = parseFrontmatter(text);
  if (!fm) return [{ line: 1, message: 'no frontmatter (needs title, status, repos, created)' }];
  const { data: d, lines } = fm;
  const at = (k) => lines[k] ?? 1;
  const out = [];
  if (!d.title || typeof d.title !== 'string') out.push({ line: at('title'), message: '`title` is missing or empty' });
  if (!d.status) out.push({ line: at('status'), message: '`status` is missing' });
  else if (!STATUSES.includes(d.status)) out.push({ line: at('status'), message: `status "${d.status}" is not one of ${STATUSES.join(', ')}` });
  if (!Array.isArray(d.repos) || d.repos.length === 0) out.push({ line: at('repos'), message: '`repos` must be a non-empty list' });
  else if (new Set(d.repos).size !== d.repos.length) out.push({ line: at('repos'), message: '`repos` has duplicates' });
  if (!d.created) out.push({ line: at('created'), message: '`created` is missing' });
  else if (!validDate(d.created)) out.push({ line: at('created'), message: `created "${d.created}" is not a YYYY-MM-DD date` });
  if (d.completed !== undefined && !validDate(d.completed)) out.push({ line: at('completed'), message: `completed "${d.completed}" is not a YYYY-MM-DD date` });
  if ((d.status === 'completed' || d.status === 'abandoned') && !d.completed) out.push({ line: at('status'), message: `a ${d.status} plan needs a \`completed\` date` });
  return out;
}

export function run({ plansDir }) {
  const findings = [];
  let n = 0;
  if (existsSync(plansDir)) {
    for (const name of readdirSync(plansDir).sort()) {
      if (!name.endsWith('.md') || name === 'README.md') continue;
      n++;
      const file = join(plansDir, name);
      for (const f of checkPlanText(readFileSync(file, 'utf8'))) findings.push({ file, ...f });
    }
  }
  return { findings, summary: existsSync(plansDir) ? `${n} plan(s)` : 'no plans directory' };
}
