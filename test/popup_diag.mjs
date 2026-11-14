// popup 启动诊断：捕获所有异常
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const EXT = decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const EXE = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'pw-popup-diag');
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
const child = spawn(EXE, [
  '--user-data-dir=' + PROFILE, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore','ignore','ignore','pipe','pipe'] });
let buf = Buffer.alloc(0);
const pending = new Map();
let seq = 0;
const exceptions = [];
child.stdio[4].on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  let i;
  while ((i = buf.indexOf(0)) !== -1) {
    const raw = buf.subarray(0, i).toString('utf8');
    buf = buf.subarray(i + 1);
    if (!raw.trim()) continue;
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') {
      const dd = m.params.exceptionDetails;
      exceptions.push((dd.exception && dd.exception.description || dd.text).slice(0, 400));
    }
  }
});
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const mid = ++seq;
  pending.set(mid, res);
  child.stdio[3].write(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const ev = async (expr, sid) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.result && r.result.exceptionDetails) {
    const dd = r.result.exceptionDetails;
    throw new Error((dd.exception && dd.exception.description || dd.text).slice(0, 400));
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await sleep(2500);
  const load = await send('Extensions.loadUnpacked', { path: EXT });
  const extId = load.result.id;
  const t = await send('Target.createTarget', { url: 'chrome-extension://' + extId + '/popup/popup.html' });
  await sleep(1200);
  const att = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
  const sid = att.result.sessionId;
  await send('Runtime.enable', {}, sid);
  await sleep(3000);
  const state = await ev(`(() => {
    const q = (id) => document.getElementById(id);
    return {
      pageKind: q('pageKind').textContent,
      errorBox: q('errorBox').classList.contains('hidden') ? null : q('errorBox').textContent.slice(0, 120),
      dirText: q('dirText').textContent.slice(0, 100),
      ver: q('verText').textContent,
      savezoneCards: !!document.querySelector('#cardsBox .savezone')
    };
  })()`, sid);
  console.log('popup state:', JSON.stringify(state, null, 2));
  console.log('exceptions captured:', exceptions.length);
  exceptions.slice(0, 5).forEach((e) => console.log('  EXC:', e));
  await send('Browser.close');
  await sleep(800);
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('DIAG FAIL', e.message); console.log('exceptions:', exceptions.join(' | ').slice(0, 800)); child.kill(); process.exit(1); });
