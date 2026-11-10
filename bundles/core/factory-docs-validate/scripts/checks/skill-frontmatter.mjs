// Every SKILL.md has frontmatter whose `name` matches its directory and a `description` of at most
// 600 characters (it loads into every session, so it stays short).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '../lib.mjs';

export const MAX_DESCRIPTION = 600;

export function checkSkillText(dirName, text) {
  const fm = parseFrontmatter(text);
  if (!fm) return [{ line: 1, message: 'SKILL.md has no frontmatter (--- name / description ---)' }];
  const out = [];
  const { name, description } = fm.data;
  if (!name) out.push({ line: 1, message: 'frontmatter has no `name`' });
  else if (name !== dirName) out.push({ line: fm.lines.name, message: `name "${name}" does not match the directory "${dirName}"` });
  if (!description) out.push({ line: fm.lines.description ?? 1, message: 'frontmatter has no `description`' });
  else if (description.length > MAX_DESCRIPTION) out.push({ line: fm.lines.description, message: `description is ${description.length} chars; the limit is ${MAX_DESCRIPTION}. Move detail into the body` });
  return out;
}

export function run({ skillsDir }) {
  const findings = [];
  let skills = 0;
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir).sort()) {
      const file = join(skillsDir, name, 'SKILL.md');
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      skills++;
      for (const f of checkSkillText(name, readFileSync(file, 'utf8'))) findings.push({ file, ...f });
    }
  }
  return { findings, summary: `${skills} skill(s)` };
}
