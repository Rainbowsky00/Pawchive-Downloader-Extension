// 弹窗勾选 UI 测试：用假的 chrome.tabs 返回 2 个帖子，验证列表渲染、全选/全不选、
// 以及“下载选中”传给内容脚本的 urls。
// 用法：node test/popup_selection_probe.mjs
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = process.env.PW_EXT || decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.join(os.tmpdir(), 'pw-popusel-' + Date.now());
const PROFILE = path.join(ROOT, 'profile');
const PORT = 9392;
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
  '--no-first-run', '--no-default-browser-check', '--disable-sync', '--lang=en-US', 'about:blank',
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
};

(async () => {
  await connect();
  const load = await send('Extensions.loadUnpacked', { path: EXT });
  const extId = load && (load.id || (load.result && load.result.id));
  log('ext', extId);

  const t = await send('Target.createTarget', { url: 'about:blank' });
  const sid = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
  await send('Page.enable', {}, sid);
  const fake = `(() => {
    const posts = [
      { url: 'http://fake.test/post/1', title: 'Post One', date: '2026-01-01', attachments: '2' },
      { url: 'http://fake.test/post/2', title: 'Post Two', date: '2026-01-02', attachments: '3' }
    ];
    const scan = { kind: 'cards', url: 'http://fake.test/author', cards: posts, maxOffset: 0, authorId: 'local-Local Author' };
    const install = (obj, key, fn) => { try { obj[key] = fn; } catch (e) { try { Object.defineProperty(obj, key, { value: fn, configurable: true }); } catch (e2) {} } };
    install(chrome.tabs, 'query', async () => [{ id: 1, url: 'http://fake.test/author' }]);
    install(chrome.tabs, 'sendMessage', async (id, msg) => {
      if (msg.type === 'pawchiveScan') return scan;
      if (msg.type === 'pawchiveGetPosts') return { ok: true, cached: false, posts: [] };
      if (msg.type === 'pawchiveListPosts') return { ok: true, posts };
      if (msg.type === 'pawchiveCrawl') { globalThis.__crawlMsg = msg; return { started: true }; }
      return null;
    });
  })();`;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: fake }, sid);
  await send('Page.navigate', { url: `chrome-extension://${extId}/popup/popup.en.html` }, sid);
  await sleep(2500);

  const snap = () => ev(`(() => {
    const list = document.getElementById('postList');
    const boxes = list ? Array.from(list.querySelectorAll('input[type=checkbox]')) : [];
    return {
      kind: document.getElementById('pageKind').textContent,
      items: boxes.length,
      checked: boxes.filter(b => b.checked).length,
      btn: document.getElementById('btnDownloadSelected').textContent,
      titles: list ? Array.from(list.querySelectorAll('.post-title')).map(x => x.textContent) : []
    };
  })()`, sid);

  let fail = 0;
  const check = (cond, label, data) => { log((cond ? '✓ ' : '!! ') + label, JSON.stringify(data)); if (!cond) fail++; };

  const s1 = await snap();
  check(s1.kind === 'List page (author / search results)', '识别列表页', s1);
  check(s1.items === 2 && s1.checked === 2, '默认渲染 2 帖且全选', s1);
  check(s1.btn.includes('(2)'), '按钮计数为 2', s1);

  await ev(`document.getElementById('btnSelectNone').click()`, sid);
  const s2 = await snap();
  check(s2.checked === 0 && s2.btn.includes('(0)'), '全不选生效', s2);

  await ev(`document.getElementById('btnSelectAll').click()`, sid);
  const s3 = await snap();
  check(s3.checked === 2 && s3.btn.includes('(2)'), '全选生效', s3);

  await ev(`document.getElementById('btnDownloadSelected').click()`, sid);
  await sleep(500);
  const sent = await ev(`globalThis.__crawlMsg || null`, sid);
  check(!!sent && Array.isArray(sent.urls) && sent.urls.length === 2 && sent.scope === 'selected', '下载选中把 urls 传给内容脚本', sent);

  try { await send('Browser.close'); } catch { /* ignore */ }
  await sleep(400);
  try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch { /* ignore */ }
  process.exit(fail ? 2 : 0);
})().catch((e) => { console.error('FAIL', e.message); try { child.kill(); } catch { /* ignore */ } process.exit(1); });
