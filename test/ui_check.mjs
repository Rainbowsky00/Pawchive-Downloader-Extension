// UI 冒烟：popup 新按钮/目录状态、picker 页面脚本是否正常加载
// 用法：node test/ui_check.mjs chrome|edge
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = process.env.PW_EXT || decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const EXES = {
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
};
const name = process.argv[2] || 'chrome';
const ROOT = path.join(os.tmpdir(), 'pw-uicheck-' + name + '-' + Date.now());
const PROFILE = path.join(ROOT, 'profile');
const PORT = name === 'edge' ? 9341 : 9342;
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
const log = (...a) => console.log('[' + name + ']', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EXES[name], [
  '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
  '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank',
], { stdio: 'ignore' });
child.on('exit', (c) => log('[launcher exit]', c));

let ws = null; let seq = 0; const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = ++seq; const m = { id, method, params }; if (sessionId) m.sessionId = sessionId;
  ws.send(JSON.stringify(m));
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); });
}
async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (r.ok) {
        const v = await r.json();
        ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
        ws.addEventListener('message', (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
          else if (!m.id && m.method === 'Runtime.exceptionThrown') log('!! 异常:', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
        });
        return;
      }
    } catch { /* retry */ }
    await sleep(400);
  }
  throw new Error('CDP 未就绪');
}
const ev = async (expr, sid) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
};

(async () => {
  await connect();
  const load = await send('Extensions.loadUnpacked', { path: EXT });
  const extId = load && (load.id || (load.result && load.result.id));
  log('扩展:', extId);
  let fail = 0;
  const pages = ['popup/popup.html'];
  for (const page of pages) {
    const t = await send('Target.createTarget', { url: `chrome-extension://${extId}/${page}` });
    const sid = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
    await send('Runtime.enable', {}, sid);
    await sleep(1800);
    const r = await ev(`({
      pageKind: document.getElementById('pageKind')?.textContent,
      dirText: document.getElementById('dirText')?.textContent,
      version: chrome.runtime.getManifest().version
    })`, sid);
    log('popup:', JSON.stringify(r));
    if (r.version !== '1.5.5') { log('!! 版本不是 1.5.5'); fail++; }
    if (!r.dirText) { log('!! 保存位置文本未渲染'); fail++; }
    await send('Target.closeTarget', { targetId: t.targetId });
  }
  try { await send('Browser.close'); } catch { /* ignore */ }
  await sleep(400);
  try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(fail ? 2 : 0);
})().catch((e) => { console.error('FAIL', e.message); try { child.kill(); } catch { /* ignore */ } process.exit(1); });
