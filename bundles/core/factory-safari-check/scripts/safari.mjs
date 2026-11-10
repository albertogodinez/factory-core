#!/usr/bin/env node
// Drive real Safari once through safaridriver (W3C WebDriver over plain fetch): open a URL,
// run a probe, save a screenshot, close. Node built-ins only.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createServer as netServer } from 'node:net';

const USAGE = `Usage: safari.mjs --url <url> [options]
  --url <url>          Page to open. With --serve, a path relative to the served dir (default index.html).
  --serve <dir>        Serve <dir> on a free localhost port first (static files, no deps).
  --probe <file.js>    WebDriver sync script body; its return value is printed as JSON.
  --arg <value>        Passed to the probe as arguments[0] (repeatable: arguments[1], ...).
  --shot <file.png>    Save a viewport screenshot.
  --size <WxH>         Window size (default 1440x900).
  --wait <ms>          Pause after load before probing (default 500).
Exit codes: 0 ok, 2 bad usage, 3 remote automation off, 4 session or probe error.`;

const args = { arg: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  if (k === 'help') { console.log(USAGE); process.exit(0); }
  const v = argv[++i];
  if (v === undefined) { console.error(`--${k} needs a value\n${USAGE}`); process.exit(2); }
  k === 'arg' ? args.arg.push(v) : (args[k] = v);
}
if (!args.url && !args.serve) { console.error(USAGE); process.exit(2); }

const freePort = () => new Promise((res) => {
  const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const serve = async (dir) => {
  const root = resolve(dir);
  const port = await freePort();
  const srv = createServer((req, res) => {
    const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    try {
      const file = p.startsWith(root) && statSync(p).isDirectory() ? join(p, 'index.html') : p;
      if (!file.startsWith(root)) throw new Error('outside root');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { srv, base: `http://localhost:${port}/` };
};

const cleanup = [];
const done = (code) => { for (const f of cleanup.reverse()) { try { f(); } catch {} } process.exit(code); };

const driverPort = await freePort();
const driver = spawn('safaridriver', ['-p', String(driverPort)], { stdio: 'ignore' });
cleanup.push(() => driver.kill());
const base = `http://localhost:${driverPort}`;
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (j.value?.error) throw Object.assign(new Error(j.value.message || j.value.error), { webdriver: j.value.error });
  return j.value;
};
for (let i = 0; ; i++) {
  try { if ((await call('GET', '/status')).ready) break; } catch {}
  if (i > 50) { console.error('safaridriver did not start'); done(4); }
  await new Promise((r) => setTimeout(r, 100));
}

let url = args.url;
if (args.serve) {
  const { srv, base: site } = await serve(args.serve);
  cleanup.push(() => srv.close());
  url = new URL(args.url ?? 'index.html', site).href;
}

let session;
try {
  ({ sessionId: session } = await call('POST', '/session', {
    capabilities: { alwaysMatch: { browserName: 'safari', acceptInsecureCerts: true } },
  }));
} catch (e) {
  if (/remote automation/i.test(e.message)) {
    console.error('Safari remote automation is off. Safari → Settings → Advanced → "Show features for web developers", then Develop → Allow Remote Automation (or `sudo safaridriver --enable` in a real terminal).');
    done(3);
  }
  console.error(`session not created: ${e.message}`);
  done(4);
}
const s = `/session/${session}`;
cleanup.push(() => fetch(base + s, { method: 'DELETE' }).catch(() => {}));

try {
  const [w, h] = (args.size ?? '1440x900').split('x').map(Number);
  await call('POST', `${s}/window/rect`, { width: w, height: h });
  await call('POST', `${s}/url`, { url });
  await new Promise((r) => setTimeout(r, Number(args.wait ?? 500)));
  const ua = await call('POST', `${s}/execute/sync`, { script: 'return navigator.userAgent', args: [] });
  const out = { url, safari: ua.match(/Version\/([\d.]+)/)?.[1] ?? ua };
  if (args.probe) out.probe = await call('POST', `${s}/execute/sync`, { script: readFileSync(args.probe, 'utf8'), args: args.arg });
  if (args.shot) { writeFileSync(args.shot, Buffer.from(await call('GET', `${s}/screenshot`), 'base64')); out.shot = resolve(args.shot); }
  console.log(JSON.stringify(out, null, 1));
  await call('DELETE', s);
  cleanup.pop();
  done(0);
} catch (e) {
  console.error(`probe failed: ${e.message}`);
  done(4);
}
