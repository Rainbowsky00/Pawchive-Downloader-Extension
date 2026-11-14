// 监控小窗按钮状态测试：空闲/暂停/继续时，大按钮「继续下载」应只在暂停时出现
// 用法：node test/mini_ui_probe.mjs chrome|edge
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = process.env.PW_EXT || decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const EXES = {
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
};
const name = process.argv[2] || 'edge';
const ROOT = path.join(os.tmpdir(), 'pw-miniui-' + name + '-' + Date.now());
const PROFILE = path.join(ROOT, 'profile');
const DL = path.join(ROOT, 'downloads');
const PORT = name === 'edge' ? 9355 : 9356;
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
fs.mkdirSync(DL, { recursive: true });
fs.writeFileSync(path.join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: DL, prompt_for_download: false },
}));
const log = (...a) => console.log('[' + name + ']', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 本地测试文件源（带 CORS）
const BODY = Buffer.from('x'.repeat(2048));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Content-Length': BODY.length });
  res.end(BODY);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const HTTP = server.address().port;

const child = spawn(EXES[name], [
  '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
  '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank',
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
  const t = await send('Target.createTarget', { url: `chrome-extension://${extId}/mini/mini.html` });
  const sid = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, sid);
  await sleep(2000);

  const snap = () => ev(`(() => {
    const g = (id) => document.getElementById(id);
    const vis = (el) => el && getComputedStyle(el).display !== 'none' && !el.classList.contains('hidden');
    return {
      status: g('statusLine').textContent,
      pausedBoxVisible: vis(g('pausedBox')),
      btnPauseText: g('btnPause').textContent,
      btnPauseVisible: vis(g('btnPause')),
      btnPauseDisabled: g('btnPause').disabled,
      btnResume2Visible: vis(g('btnResume2'))
    };
  })()`, sid);

  let fail = 0;
  const check = (cond, label, data) => { log((cond ? '✓ ' : '!! ') + label, JSON.stringify(data)); if (!cond) fail++; };

  const idle = await snap();
  check(!idle.pausedBoxVisible, '空闲时不应显示「继续下载」大按钮', idle);
  check(idle.btnPauseVisible && idle.btnPauseText.includes('暂停'), '空闲时显示「暂停」按钮', idle);

  // 实际下载中：大按钮必须保持隐藏，「暂停」可用
  await ev(`chrome.runtime.sendMessage({ type: 'pawchiveEnqueue', payload: {
    kind:'post', pageUrl:'http://example.test/post/1', postId:'1',
    author:'监控测试', title:'Running', date:'2026-11-15',
    images:[], videos:[], attach:[], links:{drive:[], video:[], attach:[]},
    media:[1,2,3,4,5,6].map(i => ({ url:'http://127.0.0.1:${HTTP}/img?f=' + i + '.jpg', filename:i + '.jpg', ext:'jpeg', kind:'image' }))
  }, options: { rename: true, root: '' } })`, sid);
  let running = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const s = await ev(`chrome.runtime.sendMessage({ type: 'pawchiveGetState' })`, sid);
    if (s.running || s.queued > 0 || (s.active || []).length > 0) { running = s; break; }
  }
  const during = await snap();
  check(!!running, '已进入下载状态', during);
  check(!during.pausedBoxVisible, '下载中「继续下载」大按钮必须隐藏', during);
  check(during.btnPauseVisible && !during.btnPauseDisabled, '下载中「暂停」按钮可用', during);

  await ev(`chrome.runtime.sendMessage({ type: 'pawchivePauseQueue' })`, sid);
  await sleep(1200);
  const paused = await snap();
  check(paused.pausedBoxVisible, '暂停时应显示「继续下载」', paused);
  check(paused.btnPauseDisabled, '暂停时「暂停」按钮应禁用', paused);
  check(paused.btnResume2Visible, '暂停时显示「继续」按钮', paused);

  await ev(`chrome.runtime.sendMessage({ type: 'pawchiveResumeQueue' })`, sid);
  await sleep(1200);
  const resumed = await snap();
  check(!resumed.pausedBoxVisible, '继续后大按钮应隐藏', resumed);
  check(resumed.status !== '已暂停（手动暂停）', '继续后状态不再是已暂停', resumed);

  try { await send('Browser.close'); } catch { /* ignore */ }
  await sleep(400);
  try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(fail ? 2 : 0);
})().catch((e) => { console.error('FAIL', e.message); try { child.kill(); } catch { /* ignore */ } process.exit(1); });
