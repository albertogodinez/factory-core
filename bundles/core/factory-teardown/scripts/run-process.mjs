#!/usr/bin/env node
// A dedicated process-group leader stays alive until targeted teardown, even if the launcher exits.
import { spawn } from 'node:child_process';
import { setInterval } from 'node:timers';

let started = false;
const keepAlive = setInterval(() => {}, 60000);
process.on('disconnect', () => { if (!started) { clearInterval(keepAlive); process.exit(1); } });
process.once('message', ({ command, cwd }) => {
  started = true;
  const app = spawn(command[0], command.slice(1), { cwd, stdio: 'inherit' });
  app.once('spawn', () => process.send?.({ started: true }));
  app.once('error', error => { process.send?.({ error: error.message }); process.exitCode = 1; });
  app.once('exit', (code, signal) => console.error(`Owned server launcher exited (${code ?? signal}); group retained for teardown.`));
});
