// 本地模拟站点验证：
//  1) 只勾选第 1 帖 → 只下载第 1 帖
//  2) 勾选 2 帖 → 逐帖流水线：第 1 帖下载完才开始第 2 帖
// 用法：node test/local_sequential_probe.mjs
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = process.env.PW_EXT || decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.join(os.tmpdir(), 'pw-local-' + Date.now());
const EXT = path.join(ROOT, 'ext');
const PROFILE = path.join(ROOT, 'profile');
const DL = path.join(ROOT, 'downloads');
const PORT_CDP = 9391;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 构造测试扩展（只改 matches/permissions，其他原样） ---------- */
fs.mkdirSync(EXT, { recursive: true });
for (const item of ['background.js', 'lang.js', 'redirect.js', 'offscreen.html', 'offscreen.js', 'content', 'popup', 'mini', 'icons', '_locales']) {
  fs.cpSync(path.join(SRC, item), path.join(EXT, item), { recursive: true });
}
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
manifest.content_scripts[0].matches.push('http://127.0.0.1/*');
manifest.host_permissions = (manifest.host_permissions || []).concat(['http://127.0.0.1/*']);
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
fs.mkdirSync(DL, { recursive: true });
fs.writeFileSync(path.join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: DL, prompt_for_download: false },
}));

/* ---------- 模拟站点 ---------- */
const IMG = Buffer.from('x'.repeat(4096));
function postPage(id, title) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="published" content="2026-01-0${id}T00:00:00Z">
<meta name="service" content="local"><meta name="artist_name" content="Local Author">
<title>${title}</title></head><body>
<section id="page" class="site-section--post" data-service="local" data-user="1" data-id="p${id}">
  <h1 class="post__title"><span>${title}</span></h1>
  <a class="post__user-name" href="#">Local Author</a>
  <div class="post__published">2026-01-0${id}</div>
  <div class="post__content"><p>Test post ${id}</p></div>
  <div class="post__files">
    <a class="fileThumb" href="/img/${id}-1.jpg?f=${id}-1.jpg" download="${id}-1.jpg"><img src="/img/${id}-1.jpg"></a>
    <a class="fileThumb" href="/img/${id}-2.jpg?f=${id}-2.jpg" download="${id}-2.jpg"><img src="/img/${id}-2.jpg"></a>
  </div>
</section></body></html>`;
}
const authorPage = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="service" content="local"><meta name="artist_name" content="Local Author"><meta name="id" content="1">
<title>Posts of Local Author</title></head><body>
<h1 class="user-header__name"><span itemprop="name">Local Author</span></h1>
<article class="post-card"><a href="/post/1"></a><div class="post-card__header">Post One</div><div class="timestamp" datetime="2026-01-01">2026-01-01</div><div class="post-card__footer">2 attachments</div></article>
<article class="post-card"><a href="/post/2"></a><div class="post-card__header">Post Two</div><div class="timestamp" datetime="2026-01-02">2026-01-02</div><div class="post-card__footer">2 attachments</div></article>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/author') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(authorPage);
  } else if (u.pathname === '/post/1') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(postPage(1, 'Post One'));
  } else if (u.pathname === '/post/2') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(postPage(2, 'Post Two'));
  } else if (u.pathname.startsWith('/img/')) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': IMG.length, 'Access-Control-Allow-Origin': '*' }); res.end(IMG);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const AUTHOR_URL = `http://127.0.0.1:${PORT}/author`;

/* ---------- CDP ---------- */
const child = spawn(EDGE, [
  '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT_CDP,
  '--no-first-run', '--no-default-browser-check', '--disable-sync', 'about:blank',
], { stdio: 'ignore' });
let ws = null; let seq = 0; const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = ++seq; const m = { id, method, params }; if (sessionId) m.sessionId = sessionId;
  ws.send(JSON.stringify(m));
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 90000); });
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result?.value;
};
const walk = (d, p = '') => {
  const out = [];
  if (!fs.existsSync(d)) return out;
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const rel = p ? p + '/' + f.name : f.name;
    if (f.isDirectory()) out.push(...walk(path.join(d, f.name), rel));
    else out.push(rel);
  }
  return out.sort();
};

(async () => {
  await connect();
  const load = await send('Extensions.loadUnpacked', { path: EXT });
  const extId = load && (load.id || (load.result && load.result.id));
  log('ext', extId);

  const page = await send('Target.createTarget', { url: AUTHOR_URL });
  const gsid = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, gsid);
  await sleep(2000);

  const popup = await send('Target.createTarget', { url: `chrome-extension://${extId}/popup/popup.html` });
  const psid = (await send('Target.attachToTarget', { targetId: popup.targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, psid);
  await sleep(2200);
  await ev(`(() => { globalThis.__msgs = []; chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'pawchiveCrawlProgress') globalThis.__msgs.push(m); }); return true; })()`, psid);

  const tabId = await ev(`chrome.tabs.query({}).then(ts => (ts.find(t => t.url && t.url.startsWith('http://127.0.0.1')) || {}).id)`, psid);
  let scan = null;
  for (let k = 0; k < 20; k++) {
    scan = await ev(`chrome.tabs.sendMessage(${tabId}, { type: 'pawchiveScan' })`, psid).catch(() => null);
    if (scan && scan.kind === 'cards') break;
    await sleep(500);
  }
  if (!scan || !scan.cards) throw new Error('扫描失败');
  log('扫描:', JSON.stringify(scan.cards.map((c) => ({ title: c.title, url: c.url, date: c.date, att: c.attachments }))));

  const listed = await ev(`chrome.tabs.sendMessage(${tabId}, { type: 'pawchiveListPosts', scope: 'page', delay: 0, maxOffset: 0 })`, psid);
  log('列表加载:', JSON.stringify({ ok: listed && listed.ok, n: listed && listed.posts && listed.posts.length }));

  async function runCrawl(urls, label) {
    await ev(`globalThis.__msgs.length = 0`, psid);
    const started = await ev(`chrome.tabs.sendMessage(${tabId}, ${JSON.stringify({
      type: 'pawchiveCrawl', urls, scope: 'selected', delay: 100, limit: 0,
      options: { rename: true, root: '' },
    })})`, psid);
    if (!started || !started.started) throw new Error('crawl not started: ' + JSON.stringify(started));
    let done = null;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      const msgs = await ev(`globalThis.__msgs.slice()`, psid);
      done = msgs.find((m) => m.phase === 'done') || null;
      if (done) break;
    }
    const msgs = await ev(`globalThis.__msgs.slice()`, psid);
    const st = await ev(`chrome.runtime.sendMessage({ type: 'pawchiveGetState' })`, psid);
    log(label, JSON.stringify({
      done: done && { posts: done.posts, failed: done.failed, skipped: done.skipped },
      queued: msgs.filter((m) => m.phase === 'postQueued').map((m) => m.index),
      waits: msgs.filter((m) => m.phase === 'postWait').map((m) => m.index),
      completed: st && st.completed, failed: st && st.failed,
      files: walk(DL),
    }));
    return { msgs, done, st };
  }

  // 1) 只选第 1 帖
  const r1 = await runCrawl([scan.cards[0].url], '只选第1帖');
  const onlyOne = walk(DL).some((f) => f.includes('Post One')) && !walk(DL).some((f) => f.includes('Post Two'));

  // 2) 清空完成记录后选 2 帖，验证逐帖顺序
  await ev(`chrome.runtime.sendMessage({ type: 'pawchiveResetRecords' })`, psid);
  await sleep(800);
  const r2 = await runCrawl([scan.cards[0].url, scan.cards[1].url], '选2帖');
  const msgs = r2.msgs;
  const q1 = msgs.findIndex((m) => m.phase === 'postQueued' && m.index === 1);
  const w1 = msgs.findIndex((m) => m.phase === 'postWait' && m.index === 1);
  const q2 = msgs.findIndex((m) => m.phase === 'postQueued' && m.index === 2);
  const sequential = q1 >= 0 && w1 >= 0 && q2 > w1;
  const both = walk(DL).some((f) => f.includes('Post One')) && walk(DL).some((f) => f.includes('Post Two'));

  log('顺序:', JSON.stringify({ q1, w1, q2, sequential }));
  log('文件:', JSON.stringify(walk(DL)));
  const ok = onlyOne && both && sequential && r2.done && r2.done.posts === 2;
  log(ok ? '✓ 勾选下载 + 逐帖流水线正常' : '!! 验证失败');

  try { await send('Browser.close'); } catch { /* ignore */ }
  await sleep(500);
  try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch { /* ignore */ }
  server.close();
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('FAIL', e.message); try { child.kill(); } catch { /* ignore */ } server.close(); process.exit(1); });
