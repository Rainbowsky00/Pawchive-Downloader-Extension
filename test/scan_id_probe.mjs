// 验证列表页 ID 文案：应返回 <渠道>-<作者ID>，例如 fanbox-creator
// 用法：node test/scan_id_probe.mjs [作者页URL]
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = process.env.PW_EXT || decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_ARG = process.argv[2];
if (!URL_ARG) { console.error('Usage: node test/scan_id_probe.mjs <author-url>'); process.exit(1); }
const ROOT = path.join(os.tmpdir(), 'pw-scanid-' + Date.now());
const PROFILE = path.join(ROOT, 'profile');
const PORT = 9359;
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
  '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank',
], { stdio: 'ignore' });

let ws = null; let seq = 0; const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = ++seq; const m = { id, method, params }; if (sessionId) m.sessionId = sessionId;
  ws.send(JSON.stringify(m));
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000); });
}
async function connect() {
  for (let i = 0; i < 100; i++) {
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
};

(async () => {
  await connect();
  const load = await send('Extensions.loadUnpacked', { path: EXT });
  const extId = load && (load.id || (load.result && load.result.id));
  log('ext', extId);

  const page = await send('Target.createTarget', { url: URL_ARG });
  const gsid = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, gsid);
  for (let i = 0; i < 90; i++) {
    await sleep(1500);
    const n = await ev(`document.querySelectorAll('article.post-card').length`, gsid).catch(() => 0);
    if (n > 0) break;
    if (i % 10 === 0) log('等待页面…');
  }

  const popup = await send('Target.createTarget', { url: `chrome-extension://${extId}/popup/popup.html` });
  const psid = (await send('Target.attachToTarget', { targetId: popup.targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, psid);
  await sleep(1000);

  const tabId = await ev(`chrome.tabs.query({}).then(ts => (ts.find(t => t.url && t.url.startsWith('https://pawchive.pw/')) || {}).id)`, psid);
  let scan = null;
  for (let k = 0; k < 20; k++) {
    scan = await ev(`chrome.tabs.sendMessage(${tabId}, { type: 'pawchiveScan' })`, psid).catch(() => null);
    if (scan && scan.kind === 'cards') break;
    await sleep(1000);
  }
  log('scan:', JSON.stringify({ kind: scan && scan.kind, cards: scan && scan.cards && scan.cards.length, authorId: scan && scan.authorId }));
  if (!scan || !scan.authorId) {
    log('!! 未获取到作者 ID');
    process.exitCode = 2;
  } else {
    log('✓ 作者 ID:', scan.authorId);
  }

  // 模拟 htmx 换页后 <head> meta 仍是上一页：ID 应仍来自当前 URL + 可见作者名
  try {
    await ev(`(() => {
      const a = document.querySelector('meta[name="artist_name"]');
      const s = document.querySelector('meta[name="service"]');
      if (a) a.setAttribute('content', 'STALE_AUTHOR');
      if (s) s.setAttribute('content', 'stale');
      return true;
    })()`, gsid);
    await sleep(300);
    const scan2 = await ev(`chrome.tabs.sendMessage(${tabId}, { type: 'pawchiveScan' })`, psid);
    log('scan (stale meta):', JSON.stringify({ authorId: scan2 && scan2.authorId }));
    if (!scan2 || !scan2.authorId || /stale/i.test(scan2.authorId)) {
      log('!! stale meta 仍影响 ID');
      process.exitCode = 2;
    } else {
      log('✓ stale meta 不影响 ID');
    }
  } catch (e) {
    log('!! stale meta 测试失败:', e.message);
    process.exitCode = 2;
  }

  try { await send('Browser.close'); } catch { /* ignore */ }
  await sleep(400);
  try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FAIL', e.message); try { child.kill(); } catch { /* ignore */ } process.exit(1); });
