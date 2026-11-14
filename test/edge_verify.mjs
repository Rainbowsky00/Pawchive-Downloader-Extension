// Edge 验证（websocket CDP）：复用已装扩展的 profile，绕开不稳定的 pipe
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DL_ROOT = path.join(os.tmpdir(), 'pawchive-dl-' + Date.now());
const PORT = 9223;
const PROFILE = path.join(os.tmpdir(), 'pw-final-edge3');
const AUTHOR_URL = process.env.PW_AUTHOR_URL || process.argv[2];
if (!AUTHOR_URL) { console.error('Usage: PW_AUTHOR_URL=<author-url> node test/edge_verify.mjs'); process.exit(1); }
const DELAY_MS = 800;

fs.mkdirSync(DL_ROOT, { recursive: true });
// Preferences 确保下载目录
const prefsPath = path.join(PROFILE, 'Default', 'Preferences');
try {
  const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  prefs.download = Object.assign(prefs.download || {}, { default_directory: DL_ROOT, prompt_for_download: false });
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  console.log('download dir set');
} catch (e) { console.log('prefs skip:', e.message.slice(0, 80)); }

const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });
child.on('exit', (c) => console.log('[edge exit]', c));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null;
let seq = 0;
const pending = new Map();
let eventHandler = null;

function wsSend(method, params = {}, sessionId) {
  const id = ++seq;
  const m = { id, method, params };
  if (sessionId) m.sessionId = sessionId;
  ws.send(JSON.stringify(m));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
    }, 60000);
  });
}

async function waitPort() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (r.ok) {
        const v = await r.json();
        return v.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('调试端口未启动');
}

async function connect(wsUrl) {
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (!msg.id && eventHandler) {
      eventHandler(msg);
    }
  });
}

async function evalIn(sid, expr) {
  const r = await wsSend('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result && r.result.value;
}

(async () => {
  const wsUrl = await waitPort();
  console.log('CDP 端口就绪');
  await connect(wsUrl);

  // 找扩展 SW
  const tg = await wsSend('Target.getTargets');
  const swInfo = (tg.result.targetInfos || []).find((x) => x.type === 'service_worker' && x.url.includes('background.js'));
  const extId = swInfo ? swInfo.url.match(/chrome-extension:\/\/([^/]+)\//)[1] : null;
  if (!swInfo) throw new Error('扩展 SW 未运行（扩展可能未安装到该 profile）');
  console.log('扩展 SW:', extId);
  const swSess = (await wsSend('Target.attachToTarget', { targetId: swInfo.targetId, flatten: true })).result.sessionId;

  await wsSend('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_ROOT, eventsEnabled: true }, undefined);

  // 打开作者页
  const t = await wsSend('Target.createTarget', { url: AUTHOR_URL });
  const pageSess = (await wsSend('Target.attachToTarget', { targetId: t.result.targetId, flatten: true })).result.sessionId;
  for (let i = 0; i < 30; i++) {
    const r = await evalIn(ws, `document.querySelectorAll('article.post-card').length`, pageSess).catch(() => 0);
    if (r > 0) break;
    await sleep(1000);
  }
  console.log('页面就绪，post-card:', await evalIn(ws, `document.querySelectorAll('article.post-card').length`, pageSess));

  // 扫描
  const scan = await evalIn(swSess, `chrome.tabs.query({}).then(async (ts) => {
    const tab = ts.find((x) => x.url && x.url.startsWith('https://pawchive.pw/'));
    return { tabId: tab.id, scan: await chrome.tabs.sendMessage(tab.id, { type: 'pawchiveScan' }) };
  })`, swSess);
  console.log('扫描: 本页', scan.scan.cards.length, '帖, maxOffset=', scan.scan.maxOffset);

  // 开始爬取（只 3 帖）
  await evalIn(swSess, `chrome.tabs.sendMessage(${scan.tabId}, { type: 'pawchiveCrawl', scope: 'all', delay: 800, limit: 3, maxOffset: ${scan.scan.maxOffset || 0}, dateFrom: '', dateTo: '', options: { rename: true, root: '' } })`, swSess);

  // 轮询直到完成 + 排空
  let last = '';
  for (let i = 0; i < 180; i++) {
    await sleep(3000);
    const st = await evalIn(swSess, `(async () => {
      const items = await chrome.downloads.search({});
      return { q: queue.length, done: doneSet.size, active: items.filter(d => d.state === 'in_progress').length,
               prog: (globalThis.__e2e || []).filter(m => m.type === 'pawchiveCrawlProgress').slice(-1)[0] || null };
    })()`, swSess).catch(e => ({ evalErr: String(e).slice(0, 100) }));
    const line = st.evalErr ? ('EVAL ERR ' + st.evalErr) :
      `下载中: 队列=${st.q} 在途=${st.active} 完成=${st.done} | ${st.prog ? (st.prog.phase + ' ' + (st.prog.index || '') + '/' + (st.prog.total || st.prog.posts || '')) : ''}`;
    if (line !== last) { console.log(new Date().toISOString().slice(11, 19), line); last = line; }
    if (st.prog && st.prog.phase === 'done' && st.q === 0 && st.active === 0) break;
  }

  // 磁盘统计
  console.log('===== 完成，等待文件落盘 =====');
  await sleep(5000);
  process.exit(0);
})().catch((e) => { console.error('VERIFY FAIL', e.message); process.exit(1); });
