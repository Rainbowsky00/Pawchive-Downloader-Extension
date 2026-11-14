// 对比 Chrome / Edge 的 downloads.download 文件名行为（WebSocket CDP 版，Edge 更稳定）
// 检测：部分浏览器会忽略 API filename（含子目录），改用 URL/Content-Disposition。
// 用法：node test/dl_behavior_probe.mjs chrome|edge
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const EXES = {
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
};
const name = process.argv[2] || 'edge';
const exe = EXES[name];
const ROOT = path.join(os.tmpdir(), 'pw-dlprobe-' + name + '-' + Date.now());
const PROFILE = path.join(ROOT, 'profile');
const DL = path.join(ROOT, 'downloads');
const PORT_CDP = name === 'edge' ? 9333 : 9334;
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
fs.mkdirSync(DL, { recursive: true });
const log = (...a) => console.log('[' + name + ']', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BODY = Buffer.from('0123456789abcdef'.repeat(200));
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/img')) {
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Disposition': 'attachment; filename="ORIGINAL_SERVER_NAME.jpg"',
      'Content-Length': BODY.length,
    });
    res.end(BODY);
  } else if (req.url.startsWith('/plain')) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': BODY.length });
    res.end(BODY);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const child = spawn(exe, [
  '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT_CDP,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  'about:blank',
], { stdio: 'ignore' });
child.on('exit', (c) => log('[launcher exit]', c));

let ws = null;
let seq = 0;
const pending = new Map();
function wsSend(method, params = {}, sessionId) {
  const id = ++seq;
  const m = { id, method, params };
  if (sessionId) m.sessionId = sessionId;
  ws.send(JSON.stringify(m));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 45000);
  });
}
async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT_CDP + '/json/version');
      if (r.ok) {
        const v = await r.json();
        ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
        ws.addEventListener('message', (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id); pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
          }
        });
        return;
      }
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('CDP 端口未就绪');
}
const ev = async (expr, sid) => {
  const r = await wsSend('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result && r.result.value;
};

// 在扩展页面里执行一次下载并等待完成
const runDownload = (urlExpr, filename, label) => `
(async () => {
  const url = ${urlExpr};
  const id = await new Promise((res) => chrome.downloads.download({
    url, filename: ${JSON.stringify(filename)}, conflictAction: 'overwrite', saveAs: false
  }, res));
  if (id === undefined) return { label: ${JSON.stringify(label)}, acceptError: chrome.runtime.lastError?.message || 'undefined' };
  for (let i = 0; i < 150; i++) {
    const [it] = await chrome.downloads.search({ id });
    if (it && (it.state === 'complete' || it.state === 'interrupted')) {
      return { label: ${JSON.stringify(label)}, state: it.state, error: it.error, filename: it.filename, bytes: it.bytesReceived };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { label: ${JSON.stringify(label)}, timeout: true };
})()`;

(async () => {
  await connect();
  log('CDP 就绪');
  let load;
  try { load = await wsSend('Extensions.loadUnpacked', { path: EXT }); } catch (e) { log('loadUnpacked:', e.message); }
  const extId = load && (load.id || (load.result && load.result.id));
  log('扩展:', extId);

  const t = await wsSend('Target.createTarget', { url: 'chrome-extension://' + extId + '/popup/popup.html' });
  const sid = (await wsSend('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
  await wsSend('Runtime.enable', {}, sid);
  await sleep(1500);
  await wsSend('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });

  log('manifest:', JSON.stringify(await ev(`({id: chrome.runtime.id, perms: chrome.runtime.getManifest().permissions})`, sid)));
  log('onDeterminingFilename API:', await ev(`typeof chrome.downloads.onDeterminingFilename`, sid));

  const results = [];
  results.push(await ev(runDownload(`'http://127.0.0.1:${PORT}/img?f=orig.jpg'`, 'TestAuthor/2026-11-14-Some Title/001.jpeg', 'CD+子目录编号'), sid));
  results.push(await ev(runDownload(`'http://127.0.0.1:${PORT}/plain?f=orig.jpg'`, 'TestAuthor/2026-11-14-Some Title/002.jpeg', '无CD+子目录编号'), sid));
  results.push(await ev(runDownload(`'http://127.0.0.1:${PORT}/img?f=orig.jpg'`, '003.jpeg', 'CD+仅文件名'), sid));
  results.push(await ev(runDownload(`URL.createObjectURL(new Blob([new Uint8Array(3200)], {type:'image/jpeg'}))`, 'BlobAuthor/2026-11-14-Blob Title/004.jpeg', 'blob URL+子目录编号'), sid));
  results.push(await ev(runDownload(`'data:image/jpeg;base64,' + btoa('x'.repeat(3200))`, 'DataAuthor/2026-11-14-Data Title/005.jpeg', 'data URL+子目录编号'), sid));
  console.log(JSON.stringify(results, null, 2));

  // onDeterminingFilename 覆盖测试
  const odfResult = await ev(`(async () => {
    let fired = 0;
    const listener = (item, suggest) => {
      if (!item.url.startsWith('http://127.0.0.1:${PORT}/')) { suggest(); return; }
      fired++;
      suggest({ filename: 'ForcedAuthor/2026-11-14-Forced Title/037.jpeg', conflictAction: 'overwrite' });
    };
    chrome.downloads.onDeterminingFilename.addListener(listener);
    const id = await new Promise((res) => chrome.downloads.download({
      url: 'http://127.0.0.1:${PORT}/img?f=orig.jpg', filename: 'TestAuthor/x/999.jpeg',
      conflictAction: 'overwrite', saveAs: false
    }, res));
    for (let i = 0; i < 150; i++) {
      const [it] = await chrome.downloads.search({ id });
      if (it && (it.state === 'complete' || it.state === 'interrupted')) {
        chrome.downloads.onDeterminingFilename.removeListener(listener);
        return { fired, state: it.state, filename: it.filename, error: it.error };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    chrome.downloads.onDeterminingFilename.removeListener(listener);
    return { fired, timeout: true };
  })()`, sid);
  log('onDeterminingFilename 覆盖:', JSON.stringify(odfResult));

  log('磁盘文件：');
  const walk = (d, p = '') => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const rel = p ? p + '/' + f.name : f.name;
    if (f.isDirectory()) walk(path.join(d, f.name), rel); else log('  ', rel, fs.statSync(path.join(d, f.name)).size);
  } };
  walk(DL);

  try { await wsSend('Browser.close'); } catch { /* ignore */ }
  await sleep(500);
  try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch { /* ignore */ }
  server.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); try { child.kill(); } catch { /* ignore */ } server.close(); process.exit(1); });
