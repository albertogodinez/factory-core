import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ENCODE = fileURLToPath(new URL('./encode.sh', import.meta.url));
const shellTest = process.platform === 'win32' ? test.skip : test;
function encode(mode, marks = true) {
  const dir = mkdtempSync(join(tmpdir(), 'encode-test-'));
  const bin = join(dir, 'bin'), frames = join(dir, 'frames'), out = join(dir, 'out'), raw = join(dir, 'take.webm');
  mkdirSync(bin);
  writeFileSync(raw, 'take');
  if (marks) writeFileSync(`${raw}.marks`, '1\tlanded\n');
  const tool = (name, body) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  tool('mktemp', 'mkdir -p "$FRAMES_FOR_TEST"; printf "%s\\n" "$FRAMES_FOR_TEST"');
  tool('ffprobe', 'echo 6');
  tool('ffmpeg', `if [[ " $* " == *" -ss "* ]]; then
  if [ "$FAIL_MODE" = fail ]; then exit 9; fi
  if [ "$FAIL_MODE" = term ]; then kill -TERM "$PPID"; exit 0; fi
fi
for last; do :; done
printf output > "$last"`);
  const result = spawnSync('bash', [ENCODE, raw, out, 'take'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAIL_MODE: mode, FRAMES_FOR_TEST: frames, BASH_ENV: '' }, encoding: 'utf8', timeout: 30000,
  });
  return { ...result, dir, frames, out };
}

shellTest('marked-frame failure cleans its temp directory and retains the failure status', () => {
  const r = encode('fail');
  try {
    assert.equal(r.status, 9, r.stderr);
    assert.equal(existsSync(r.frames), false);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

shellTest('TERM cleans marked frames and exits with signal status', () => {
  const r = encode('term');
  try {
    assert.ok(r.status === 143 || r.signal === 'SIGTERM', JSON.stringify(r));
    assert.equal(existsSync(r.frames), false);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

shellTest('successful marked and unmarked encoding keeps final output and cleans scratch', () => {
  for (const marks of [true, false]) {
    const r = encode('ok', marks);
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(join(r.out, 'take.mp4'), 'utf8'), 'output');
      assert.equal(existsSync(join(r.out, 'contact-sheet.jpg')), true);
      assert.equal(existsSync(r.frames), false);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  }
});
