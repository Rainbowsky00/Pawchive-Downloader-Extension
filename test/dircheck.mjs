// popup 保存位置渲染 + 无气泡验证
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const EXT = decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const EXES = {
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
};
const name = process.argv[2] || 'chrome';
const exe = EXES[name];
const PROFILE = path.join(os.tmpdir(), 'pw-dircheck-' + name);
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
const child = spawn(exe, [
  '--user-data-dir=' + PROFILE, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
child.on('exit', (c) => console.log('[exit] edge/chrome exit:', c));
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
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const mid = ++seq;
  pending.set(mid, res);
  child.stdio[3].write(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const ev = async (expr, sid) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 250));
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await sleep(2500);
  const load = await send('Extensions.loadUnpacked', { path: EXT });
  const extId = load.result.id;
  // 第一次打开弹窗（探针可能触发一次下载）
  const t1 = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/popup/popup.html' });
  await sleep(4000);
  const sid1 = (await send('Target.attachToTarget', { targetId: t1.result.targetId, flatten: true })).result.sessionId;
  const r1 = await ev(`(() => ({ dir: document.getElementById('dirText').textContent, ver: chrome.runtime.getManifest().version }))()`, sid1);
  console.log('[' + name + '] v' + r1.ver + ' 第一次打开 dirText=' + JSON.stringify(r1.dir));
  const hist1 = await ev(`chrome.downloads.search({}).then(a => a.length)`, sid1);
  console.log('[' + name + '] 历史记录数（第一次后）:', hist1);
  await send('Target.closeTarget', { targetId: t1.result.targetId });
  await sleep(500);
  // 第二次打开弹窗（应零新下载）
  const t2 = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/popup/popup.html' });
  await sleep(2500);
  const sid2 = (await send('Target.attachToTarget', { targetId: t2.result.targetId, flatten: true })).result.sessionId;
  const r2 = await ev(`chrome.downloads.search({}).then(a => a.length)`, sid2);
  const dir2 = await ev(`document.getElementById('dirText').textContent`, sid2);
  console.log('[' + name + '] 第二次打开 dirText=' + JSON.stringify(dir2));
  console.log('[' + name + '] 历史记录数（第二次后，应为 0 = 无新下载）:', r2);
  await send('Browser.close');
  await sleep(800);
  child.kill();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); child.kill(); process.exit(1); });
