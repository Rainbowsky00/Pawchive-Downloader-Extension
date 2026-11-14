// 真实站点 Edge 端到端（WebSocket CDP，规避 Edge 管道启动不稳）：
// 加载扩展 → 打开作者页 → 选一个有附件的帖子 → 直接下载该帖 → 检查磁盘命名。
// 用法：node test/edge_real_probe.mjs [作者页URL]
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = process.env.PW_EXT || decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_ARG = process.argv[2];
if (!URL_ARG) { console.error('Usage: node test/edge_real_probe.mjs <author-url>'); process.exit(1); }
const ROOT = path.join(os.tmpdir(), 'pw-edgereal-' + Date.now());
const PROFILE = path.join(ROOT, 'profile');
const DL = path.join(ROOT, 'downloads');
const PORT_CDP = 9338;
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
fs.mkdirSync(DL, { recursive: true });
fs.writeFileSync(path.join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true },
  savefile: { default_directory: DL },
  profile: { default_content_setting_values: { automatic_downloads: 1 } },
}));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE_ARGS = [
  '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT_CDP,
  '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  'about:blank',
];
// 默认禁用同步（干净环境）；PW_SYNC=1 时保留同步，用于复现用户 Edge 里其他扩展抢名
if (process.env.PW_SYNC !== '1') EDGE_ARGS.splice(3, 0, '--disable-sync');
const child = spawn(EDGE, EDGE_ARGS, { stdio: 'ignore' });
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 90000);
  });
}
async function connect() {
  for (let i = 0; i < 100; i++) {
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
const walk = (d, p = '') => {
  const out = [];
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const rel = p ? p + '/' + f.name : f.name;
    if (f.isDirectory()) out.push(...walk(path.join(d, f.name), rel));
    else out.push([rel, fs.statSync(path.join(d, f.name)).size]);
  }
  return out;
};
const pickPageTab = (expr) => `chrome.tabs.query({}).then(ts => ${expr})`;

(async () => {
  await connect();
  log('CDP 就绪');
  if (process.env.PW_SYNC === '1') {
    // 等 Edge 同步把参考下载扩展装好，再加载本插件 → 复现用户真实安装顺序（本插件后装）
    const refDir = path.join(PROFILE, 'Default', 'Extensions', 'ehkllobjkjjlggbmkcjkbojhicefhnhg');
    for (let i = 0; i < 150 && !fs.existsSync(refDir); i++) await sleep(1000);
    log('参考扩展已就位:', fs.existsSync(refDir));
    await sleep(3000);
  }
  const load = await wsSend('Extensions.loadUnpacked', { path: EXT });
  const extId = load && (load.id || (load.result && load.result.id));
  log('扩展:', extId);

  // 控制端：扩展页面（避免 MV3 SW 空闲回收导致 CDP 会话失效）
  const popup = await wsSend('Target.createTarget', { url: 'chrome-extension://' + extId + '/popup/popup.html' });
  const psid = (await wsSend('Target.attachToTarget', { targetId: popup.targetId, flatten: true })).sessionId;
  await wsSend('Runtime.enable', {}, psid);
  await sleep(1000);

  const page = await wsSend('Target.createTarget', { url: URL_ARG });
  const gsid = (await wsSend('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
  await wsSend('Runtime.enable', {}, gsid);

  let ready = null;
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    ready = await ev(`({ ready: document.readyState, cards: document.querySelectorAll('article.post-card').length,
      cf: !!document.querySelector('#challenge-running, .cf-turnstile') })`, gsid).catch(() => null);
    if (ready && ready.cards > 0) break;
    if (i % 10 === 0) log('等待页面…', JSON.stringify(ready));
  }
  if (!ready || !ready.cards) throw new Error('作者页未就绪: ' + JSON.stringify(ready));
  log('页面就绪，卡片数:', ready.cards);

  const tabId = await ev(pickPageTab(`(ts.find(t => t.url === ${JSON.stringify(URL_ARG)}) || ts.find(t => t.url && t.url.startsWith('https://pawchive.pw/')) || {}).id`), psid);
  if (!tabId) throw new Error('找不到 pawchive 标签页');
  log('tabId:', tabId);

  let scan = null;
  for (let k = 0; k < 30; k++) {
    scan = await ev(`chrome.tabs.sendMessage(${tabId}, { type: 'pawchiveScan' })`, psid).catch(() => null);
    if (scan && scan.kind === 'cards') break;
    await sleep(1000);
  }
  if (!scan) throw new Error('content script 未就绪');
  log('扫描: 本页', scan.cards.length, '帖, maxOffset=', scan.maxOffset);

  // 选附件数最多的帖子（优先有文件区的）
  const cands = scan.cards.filter((c) => parseInt(c.attachments, 10) > 0)
    .sort((a, b) => parseInt(b.attachments, 10) - parseInt(a.attachments, 10));
  const picked = cands[0] || scan.cards[0];
  log('选中帖子:', picked.url, 'attachments=', picked.attachments, 'date=', picked.date);

  // 打开帖子并解析
  const postTab = await wsSend('Target.createTarget', { url: picked.url });
  const postSid = (await wsSend('Target.attachToTarget', { targetId: postTab.targetId, flatten: true })).sessionId;
  await wsSend('Runtime.enable', {}, postSid);
  let payload = null;
  for (let k = 0; k < 120; k++) {
    await sleep(2000);
    // 找帖子页 tabId 后扫描
    const postTabId = await ev(pickPageTab(`(ts.find(t => t.url && t.url.includes('/post/')) || {}).id`), psid);
    if (postTabId) {
      const ps = await ev(`chrome.tabs.sendMessage(${postTabId}, { type: 'pawchiveScan' })`, psid).catch(() => null);
      if (ps && ps.kind === 'post') { payload = ps.payload; break; }
    }
    if (k % 10 === 0) log('等待帖子页…');
  }
  if (!payload) throw new Error('帖子页未解析成功');
  log('帖子:', payload.author, '|', payload.date, '|', payload.title);
  log('媒体: 图片', payload.images.length, '视频', payload.videos.length,
    '云盘', (payload.links.drive || []).length, '视频链接', (payload.links.video || []).length);
  const MEDIA_LIMIT = Math.max(0, parseInt(process.env.PW_MEDIA_LIMIT || '0', 10) || 0);
  if (MEDIA_LIMIT) {
    payload.media = (payload.media || []).slice(0, MEDIA_LIMIT);
    payload.images = (payload.images || []).slice(0, MEDIA_LIMIT);
    log('（诊断）只下载前', MEDIA_LIMIT, '个媒体');
  }

  const before = new Set(walk(DL).map(([f]) => f));
  const res = await ev(`chrome.runtime.sendMessage({ type: 'pawchiveEnqueue', payload: ${JSON.stringify(payload)}, options: { rename: true, root: '' } })`, psid);
  log('入队结果:', JSON.stringify(res));

  let last = '';
  let done = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 30 * 60 * 1000) {
    await sleep(3000);
    const st = await ev(`chrome.runtime.sendMessage({ type: 'pawchiveGetState' })`, psid).catch(() => null);
    if (!st) continue;
    const line = `队列=${st.queued} 在途=${(st.active || []).length} 完成=${st.completed} 失败=${st.failed} 命名冲突=${!!st.namingConflict}`;
    if (line !== last) { log(line); last = line; }
    if (st.completed > 0 && st.queued === 0 && !st.running && !(st.active || []).length) { done = true; break; }
    if (st.failed > 0 && st.queued === 0 && !st.running) { done = true; break; }
  }
  if (!done) throw new Error('下载超时');

  const files = walk(DL);
  const items = await ev(`chrome.downloads.search({}).then(a => a.map(x => ({state:x.state, filename:x.filename, bytes:x.bytesReceived, byExt:x.byExtensionId})))`, psid);
  log('下载记录:', JSON.stringify(items, null, 2));
  log('磁盘:', JSON.stringify(files, null, 2));
  const newFiles = files.filter(([f]) => !before.has(f));
  const bad = newFiles.filter(([f]) => /^[A-Za-z0-9_-]{20,}\./.test(f) || f.includes('NOISY'));
  const diag = await ev(`chrome.runtime.sendMessage({ type: 'pawchiveGetState' }).then(s => s.diag.filter(d => d.type === '命名异常').slice(-5))`, psid);
  if (diag && diag.length) log('命名异常诊断:', JSON.stringify(diag, null, 2));
  log(bad.length ? '!! 发现未按规则命名文件: ' + JSON.stringify(bad) : '✓ 所有新文件均已按「作者/日期-标题/编号」落盘');

  try { await wsSend('Browser.close'); } catch { /* ignore */ }
  await sleep(500);
  try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(bad.length ? 2 : 0);
})().catch((e) => { console.error('FAIL', e.message); try { child.kill(); } catch { /* ignore */ } process.exit(1); });
