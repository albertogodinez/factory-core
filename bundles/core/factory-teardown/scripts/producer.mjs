// Optional run binding shared by artifact-producing scripts. Without a run, legacy outputs stay unregistered.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

const SCRIPT = fileURLToPath(new URL('./lifecycle.mjs', import.meta.url));
export function trackOutput(path, kind = 'evidence', pending = false) {
  const run = process.env.FACTORY_RUN_ID;
  if (!run) return;
  const state = process.env.FACTORY_STATE_ROOT ? ['--state-root', process.env.FACTORY_STATE_ROOT] : [];
  const show = spawnSync(process.execPath, [SCRIPT, 'show', '--run', run, ...state], { encoding: 'utf8', timeout: 10000 });
  if (show.status !== 0) throw new Error(`cannot inspect bound run: ${show.stderr?.trim()}`);
  const active = JSON.parse(show.stdout).status === 'active';
  const commands = active ? [['heartbeat', '--run', run]] : [];
  commands.push(['add', '--run', run, '--path', resolve(path), '--class', kind, ...(pending ? ['--pending'] : [])]);
  for (const args of commands) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, ...state], { encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0) throw new Error(`artifact registration failed: ${r.error?.message || r.stderr?.trim()}`);
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { trackOutput(process.argv[2], process.argv[3], process.argv[4] === '--pending'); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
