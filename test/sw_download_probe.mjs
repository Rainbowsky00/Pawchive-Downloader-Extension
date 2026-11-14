// 用扩展真实后台队列（SW 的 downloadJob）下载本地测试图，验证 filename（编号+子目录）是否生效。
// 不调用 Browser.setDownloadBehavior，下载目录由 profile Preferences 指定。
// 用法：node test/sw_download_probe.mjs chrome|edge
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
const exe = EXES[name];
const ROOT = path.join(os.tmpdir(), 'pw-swprobe-' + name + '-' + Date.now());
const PROFILE = path.join(ROOT, 'profile');
const DL = path.join(ROOT, 'downloads');
const PORT_CDP = name === 'edge' ? 9335 : 9336;
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
fs.mkdirSync(DL, { recursive: true });
fs.writeFileSync(path.join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true },
  savefile: { default_directory: DL },
  profile: { default_content_setting_values: { automatic_downloads: 1 } },
}));
const log = (...a) => console.log('[' + name + ']', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BODY = Buffer.from('0123456789abcdef'.repeat(200));
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/img')) {
    res.writeHead(200, {
      'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*',
      'Content-Disposition': 'attachment; filename="ORIGINAL_SERVER_NAME.jpg"',
      'Content-Length': BODY.length,
    });
    res.end(BODY);
  } else if (req.url.startsWith('/plain')) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Content-Length': BODY.length });
    res.end(BODY);
  } else if (req.url.startsWith('/zero')) {
    // 直链下载得到 0 字节 → 触发 fetch + offscreen blob 回退路径
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Content-Length': 0 });
    res.end();
  } else { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end(); }
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

const walk = (d, p = '') => {
  const out = [];
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const rel = p ? p + '/' + f.name : f.name;
    if (f.isDirectory()) out.push(...walk(path.join(d, f.name), rel));
    else out.push([rel, fs.statSync(path.join(d, f.name)).size]);
  }
  return out;
};

(async () => {
  await connect();
  if (process.env.PW_NOISY === '1' || process.env.PW_NOISY_DELAYED === '1') {
    // 先安装“干扰扩展”（模拟下载管理器），再安装本项目扩展
    const noisyDir = process.env.PW_NOISY_DELAYED === '1' ? 'noisy-delayed-ext' : 'noisy-ext';
    const noisy = await wsSend('Extensions.loadUnpacked', { path: path.join(EXT, 'test', noisyDir) });
    log('干扰扩展:', noisyDir, noisy && (noisy.id || noisy.result?.id));
    await sleep(1000);
  }
  const load = await wsSend('Extensions.loadUnpacked', { path: EXT });
  const extId = load && (load.id || (load.result && load.result.id));
  log('扩展:', extId);
  const t = await wsSend('Target.createTarget', { url: 'chrome-extension://' + extId + '/popup/popup.html' });
  const sid = (await wsSend('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
  await wsSend('Runtime.enable', {}, sid);
  await sleep(1500);
  const payload = {
    kind: 'post', pageUrl: 'http://example.test/post/1', postId: '1',
    author: '测试作者', title: 'Probe Title', date: '2026-11-14',
    images: [{ url: `http://127.0.0.1:${PORT}/img?f=a.jpg`, filename: 'a.jpg', ext: 'jpeg' }],
    videos: [],
    media: [
      { url: `http://127.0.0.1:${PORT}/img?f=a.jpg`, filename: 'a.jpg', ext: 'jpeg', kind: 'image' },
      { url: `http://127.0.0.1:${PORT}/plain?f=b.jpg`, filename: 'b.jpg', ext: 'jpeg', kind: 'image' },
      { url: `http://127.0.0.1:${PORT}/plain?f=c.jpg`, filename: 'c.jpg', ext: 'jpeg', kind: 'image' },
      { url: `http://127.0.0.1:${PORT}/plain?f=d.jpg`, filename: 'd.jpg', ext: 'jpeg', kind: 'image' },
      { url: `http://127.0.0.1:${PORT}/plain?f=e.jpg`, filename: 'e.jpg', ext: 'jpeg', kind: 'image' },
    ],
    attach: [],
    links: { drive: ['https://mega.nz/file/abc'], video: [], attach: [] },
  };
  const res = await ev(`chrome.runtime.sendMessage({ type: 'pawchiveEnqueue', payload: ${JSON.stringify(payload)}, options: { rename: true, root: '', scope: 'page', limit: 0 } })`, sid);
  log('入队结果:', JSON.stringify(res));

  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const st = await ev(`chrome.runtime.sendMessage({ type: 'pawchiveGetState' })`, sid);
    if (i % 6 === 0) log('状态:', `q=${st.queued} done=${st.completed} fail=${st.failed} pause=${st.paused} active=${JSON.stringify(st.active)} lastErr=${st.lastError}`);
    const files = walk(DL).filter(([f]) => !f.endsWith('.crdownload'));
    if (files.length) log('磁盘:', JSON.stringify(files));
    if (st.completed >= 6 && st.queued === 0 && !st.running) {
      log('完成');
      const items = await ev(`chrome.downloads.search({}).then(a => a.map(x => ({state:x.state, filename:x.filename, bytes:x.bytesReceived})))`, sid);
      log('下载记录:', JSON.stringify(items, null, 2));
      break;
    }
  }
  log('最终磁盘:', JSON.stringify(walk(DL), null, 2));

  // 单独验证 offscreen 回退路径：SW 内直接调用 saveViaOffscreen → blob URL → 后台下载
  try {
    await ev(`chrome.runtime.sendMessage({ type: 'pawchiveGetState' })`, sid).catch(() => {});
    await sleep(500);
    const tg = await wsSend('Target.getTargets');
    const swInfo = (tg.targetInfos || []).find((x) => x.type === 'service_worker' && x.url === 'chrome-extension://' + extId + '/background.js');
    if (!swInfo) { log('!! 未找到 SW，跳过 offscreen 测试'); }
    else {
      const swSid = (await wsSend('Target.attachToTarget', { targetId: swInfo.targetId, flatten: true })).sessionId;
      await wsSend('Runtime.enable', {}, swSid);
      const r = await ev(`saveViaOffscreen(btoa('hello'.repeat(640)), 'image/jpeg', '测试作者/2026-11-14-Probe Title/offscreen-fallback.jpeg')`, swSid);
      log('offscreen 保存结果:', JSON.stringify(r));
      await sleep(1500);
      log('offscreen 后磁盘:', JSON.stringify(walk(DL).filter(([f]) => f.includes('offscreen'))));
    }
  } catch (e) { log('!! offscreen 测试失败:', e.message); }

  try { await wsSend('Browser.close'); } catch { /* ignore */ }
  await sleep(500);
  try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch { /* ignore */ }
  server.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); try { child.kill(); } catch { /* ignore */ } server.close(); process.exit(1); });
