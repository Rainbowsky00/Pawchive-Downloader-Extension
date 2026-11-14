// 最小 Edge 管道探针（恢复此前成功过的版本）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const PROFILE = path.join(os.tmpdir(), 'pw-edge-probe');
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--user-data-dir=' + PROFILE, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
console.log('spawned, pid=', child.pid);
child.on('exit', (c) => console.log('edge exit:', c));
let buf = Buffer.alloc(0);
const pending = new Map();
let seq = 0;
child.stdio[4].on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  let i;
  while ((i = buf.indexOf(0)) !== -1) {
    const raw = buf.subarray(0, i).toString('utf8');
    buf = buf.subarray(i + 1);
    if (!raw.trim()) continue;
    try {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    } catch {}
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++seq;
  pending.set(mid, (m) => m.error ? rej(new Error(m.error.message)) : res(m));
  child.stdio[3].write(JSON.stringify({ id: mid, method, params }) + '\0');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await sleep(3000);
  if (child.exitCode !== null) { console.log('Edge 已退出'); process.exit(2); }
  const t = await send('Target.getTargets');
  console.log('targets ok:', t.result.targetInfos.length);
  const r = await send('Extensions.loadUnpacked', { path: decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1') });
  console.log('loadUnpacked:', JSON.stringify(r.result));
  await sleep(500);
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('PROBE FAIL', e.message); child.kill(); process.exit(1); });
