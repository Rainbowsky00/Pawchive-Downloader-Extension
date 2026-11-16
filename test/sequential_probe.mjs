// 逐帖流水线探针：
//  1) 列表加载（pawchiveListPosts）返回帖子
//  2) 用 urls 指定 2 帖，验证“上一帖下载完 → 才抓下一帖”
// 用法：node test/sequential_probe.mjs <author-url>
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = process.env.PW_EXT || decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_ARG = process.argv[2];
if (!URL_ARG) { console.error('Usage: node test/sequential_probe.mjs <author-url>'); process.exit(1); }

const ROOT = path.join(os.tmpdir(), 'pw-seq-' + Date.now());
const PROFILE = path.join(ROOT, 'profile');
const DL = path.join(ROOT, 'downloads');
const PORT = 9390;
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
fs.mkdirSync(DL, { recursive: true });
fs.writeFileSync(path.join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: DL, prompt_for_download: false },
}));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
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
  for (let i = 0; i < 120; i++) {
    await sleep(1500);
    const n = await ev(`document.querySelectorAll('article.post-card').length`, gsid).catch(() => 0);
    if (n > 0) break;
    if (i % 10 === 0) log('等待作者页…');
  }
  log('作者页卡片:', await ev(`document.querySelectorAll('article.post-card').length`, gsid));

  const popup = await send('Target.createTarget', { url: `chrome-extension://${extId}/popup/popup.html` });
  const psid = (await send('Target.attachToTarget', { targetId: popup.targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, psid);
  await sleep(2200);
  await ev(`(() => { globalThis.__msgs = []; chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'pawchiveCrawlProgress') globalThis.__msgs.push(m); }); return true; })()`, psid);

  const tabId = await ev(`chrome.tabs.query({}).then(ts => (ts.find(t => t.url && t.url.startsWith('https://pawchive.pw/')) || {}).id)`, psid);
  let scan = null;
  for (let k = 0; k < 20; k++) {
    scan = await ev(`chrome.tabs.sendMessage(${tabId}, { type: 'pawchiveScan' })`, psid).catch(() => null);
    if (scan && scan.kind === 'cards') break;
    await sleep(1000);
  }
  if (!scan || !scan.cards) throw new Error('扫描失败');
  log('扫描:', scan.cards.length, '帖, maxOffset=', scan.maxOffset);

  // 列表加载测试（只当前页）
  const listed = await ev(`chrome.tabs.sendMessage(${tabId}, { type: 'pawchiveListPosts', scope: 'page', delay: 0, maxOffset: 0 })`, psid);
  log('列表加载:', JSON.stringify({ ok: listed && listed.ok, posts: listed && listed.posts && listed.posts.length, first: listed && listed.posts && listed.posts[0] }));
  if (!listed || !listed.ok || !listed.posts || !listed.posts.length) throw new Error('列表加载失败');

  // 选 2 个有附件的帖子
  const picked = scan.cards.filter((c) => parseInt(c.attachments, 10) > 0).slice(0, 2);
  const chosen = (picked.length ? picked : scan.cards.slice(0, 2)).map((c) => c.url);
  log('选中帖子:', JSON.stringify(chosen));
  if (!chosen.length) throw new Error('没有可测试的帖子');

  const started = await ev(`chrome.tabs.sendMessage(${tabId}, ${JSON.stringify({
    type: 'pawchiveCrawl', urls: chosen, scope: 'selected', delay: 300, limit: 0,
    options: { rename: true, root: '' },
  })})`, psid);
  log('启动:', JSON.stringify(started));

  let doneMsg = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 20 * 60 * 1000) {
    await sleep(2000);
    const msgs = await ev(`globalThis.__msgs.slice()`, psid).catch(() => []);
    const done = msgs.find((m) => m.phase === 'done');
    if (done) { doneMsg = done; break; }
    const last = msgs[msgs.length - 1];
    if (last && last.phase === 'postWait') {
      log(`等待第 ${last.index}/${last.total} 帖：剩余 ${last.pending}（完成 ${last.done}）`);
    }
  }
  const msgs = await ev(`globalThis.__msgs.slice()`, psid).catch(() => []);
  const phases = msgs.map((m) => m.phase);
  const queued = msgs.filter((m) => m.phase === 'postQueued');
  const waits = msgs.filter((m) => m.phase === 'postWait');
  const q1 = msgs.findIndex((m) => m.phase === 'postQueued' && m.index === 1);
  const w1 = msgs.findIndex((m) => m.phase === 'postWait' && m.index === 1);
  const q2 = msgs.findIndex((m) => m.phase === 'postQueued' && m.index === 2);

  const st = await ev(`chrome.runtime.sendMessage({ type: 'pawchiveGetState' })`, psid);
  log('完成消息:', JSON.stringify(doneMsg));
  log('阶段统计:', JSON.stringify({ postQueued: queued.length, postWait: waits.length, done: !!doneMsg }));
  log('顺序检查:', JSON.stringify({ q1, w1, q2, sequential: q1 >= 0 && w1 >= 0 && (q2 < 0 || w1 < q2) }));
  log('下载状态:', JSON.stringify({ completed: st && st.completed, failed: st && st.failed, queued: st && st.queued }));

  const ok = !!doneMsg && q1 >= 0 && w1 >= 0 && (q2 < 0 || w1 < q2) && (!st || st.completed > 0);
  log(ok ? '✓ 逐帖流水线与列表加载正常' : '!! 逐帖流水线验证失败');

  try { await send('Browser.close'); } catch { /* ignore */ }
  await sleep(500);
  try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('FAIL', e.message); try { child.kill(); } catch { /* ignore */ } process.exit(1); });
