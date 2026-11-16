// 复现用户场景：浏览器界面语言 zh-CN，但语言偏好列表第一项是 en-US → 扩展应显示英文。
// 通过 CDP 在扩展页面加载前注入 navigator.language 覆盖，模拟“偏好列表已改、界面语言未变”。
// 用法：node test/lang_mismatch_probe.mjs
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = process.env.PW_EXT || String.raw`E:\备份\Rainb\PycharmProjects\pic-manage-web\pawchive-downloader-store`;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.join(os.tmpdir(), 'pw-langmix-' + Date.now());
const PROFILE = path.join(ROOT, 'profile');
const PORT = 9380;
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--lang=zh-CN', 'about:blank',
], { stdio: 'ignore' });

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
  log('ext', extId);

  // about:blank → 注入 navigator.language=en-US → 再导航到扩展页面
  const t = await send('Target.createTarget', { url: 'about:blank' });
  const sid = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
  await send('Page.enable', {}, sid);
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
             Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'zh-CN'] });`,
  }, sid);
  await send('Page.navigate', { url: `chrome-extension://${extId}/popup/popup.html` }, sid);
  await sleep(2500);

  const r = await ev(`({
    path: location.pathname,
    uiLang: chrome.i18n.getUILanguage(),
    navLang: navigator.language
  })`, sid);
  log('结果:', JSON.stringify(r));
  const ok = /popup\.en\.html$/.test(r.path) && r.uiLang.startsWith('zh') && r.navLang === 'en-US';
  log(ok ? '✓ 界面中文 + 偏好英语 → 扩展显示英文（符合预期）' : '!! 未按预期切换');
  try { await send('Browser.close'); } catch { /* ignore */ }
  await sleep(400);
  try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('FAIL', e.message); try { child.kill(); } catch { /* ignore */ } process.exit(1); });
