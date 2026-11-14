// 语言自动切换测试：zh-CN -> 中文，zh-TW / en-US -> 英文
// 用法：node test/lang_probe.mjs
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = process.env.PW_EXT || decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CASES = [
  { lang: 'zh-CN', expect: 'zh' },
  { lang: 'zh-TW', expect: 'en' },
  { lang: 'en-US', expect: 'en' },
];
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let portSeq = 9370;

async function runCase({ lang, expect }) {
  const ROOT = path.join(os.tmpdir(), 'pw-lang-' + lang.replace(/[^a-z]/gi, '') + '-' + Date.now());
  const PROFILE = path.join(ROOT, 'profile');
  const PORT = portSeq++;
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  const child = spawn(EDGE, [
    '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--lang=' + lang, 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null; let seq = 0; const pending = new Map();
  function send(method, params = {}, sessionId) {
    const id = ++seq; const m = { id, method, params }; if (sessionId) m.sessionId = sessionId;
    ws.send(JSON.stringify(m));
    return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); });
  }
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
        break;
      }
    } catch { /* retry */ }
    await sleep(400);
  }
  if (!ws) throw new Error('CDP 未就绪: ' + lang);
  const ev = async (expr, sid) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  };

  const load = await send('Extensions.loadUnpacked', { path: EXT });
  const extId = load && (load.id || (load.result && load.result.id));
  const result = { lang, expect, extId };
  for (const [name, entry] of [['popup', 'popup/popup.html'], ['mini', 'mini/mini.html']]) {
    const t = await send('Target.createTarget', { url: `chrome-extension://${extId}/${entry}` });
    const sid = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
    await send('Runtime.enable', {}, sid);
    await sleep(1800);
    result[name] = await ev(`({
      path: location.pathname,
      htmlLang: document.documentElement.lang,
      uiLang: (chrome.i18n && chrome.i18n.getUILanguage) ? chrome.i18n.getUILanguage() : navigator.language,
      manifestName: chrome.runtime.getManifest().name,
      pawLang: globalThis.PawLang ? { lang: PawLang.lang, isZh: PawLang.isZh } : null
    })`, sid).catch((e) => ({ error: String(e) }));
    await send('Target.closeTarget', { targetId: t.targetId });
  }
  try { await send('Browser.close'); } catch { /* ignore */ }
  await sleep(400);
  try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch { /* ignore */ }
  return result;
}

(async () => {
  let fail = 0;
  for (const c of CASES) {
    const r = await runCase(c);
    const popupZh = /popup\.zh\.html$/.test(r.popup?.path || '');
    const miniZh = /mini\.zh\.html$/.test(r.mini?.path || '');
    const ok = c.expect === 'zh' ? (popupZh && miniZh) : (!popupZh && !miniZh);
    log(JSON.stringify(r));
    log((ok ? '✓' : '!!') + ` ${c.lang}: expected ${c.expect}, popup=${r.popup?.path}, mini=${r.mini?.path}, ui=${r.popup?.uiLang}, manifest=${r.popup?.manifestName}`);
    if (!ok) fail++;
  }
  process.exit(fail ? 2 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
