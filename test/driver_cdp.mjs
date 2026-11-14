/**
 * 真实站点端到端测试驱动（pipe 版）：
 *   独立 profile 启动 Edge/Chrome，通过 CDP pipe 传输调用 Extensions.loadUnpacked 加载扩展
 *   （Chrome/Edge 137+ 已禁用 --load-extension，这是官方保留的自动化加载通道）
 *   之后全部走扩展自身消息管线：content script 扫描/爬取 → background 下载队列 → 磁盘
 *   下载目录 = 系统临时目录，重命名开启
 *
 * 用法：node test/driver_cdp.mjs [authorUrl ...]（缺省跑内置三个作者）
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT_DIR = decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const DL_ROOT = path.join(os.tmpdir(), 'pawchive-dl-' + Date.now());
const DELAY_MS = 800;
const LIMIT = Math.max(0, parseInt(process.env.PW_LIMIT || '0', 10) || 0);
const PER_AUTHOR_TIMEOUT_MS = 60 * 60 * 1000;   // 单作者最长 60 分钟
// profile 按浏览器分开（Chrome 与 Edge 的 profile 格式不兼容，不能共用）
const PROFILE_BASE = path.join(os.tmpdir(), 'pw-e2e-profile');
let PROFILE = PROFILE_BASE;

const AUTHORS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!AUTHORS.length) {
  console.error('Usage: node test/driver_cdp.mjs <author-url> [author-url...]');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- CDP over remote-debugging-pipe ---------------- */
/* fd3: client -> chrome；fd4: chrome -> client；消息 = JSON + '\0' */

class PipeCDP {
  constructor(child) {
    this.child = child;
    this.id = 0;
    this.pending = new Map();
    this.eventHandler = null;
    this.buf = Buffer.alloc(0);
    child.stdio[4].on('data', (d) => this._onData(d));
    // 浏览器退出 / 管道关闭时，让所有未决请求立刻失败（否则 Node 事件循环清空会静默退出）
    const failAll = (why) => {
      for (const { reject } of this.pending.values()) reject(new Error(why));
      this.pending.clear();
    };
    child.stdio[4].on('close', () => failAll('调试管道已关闭'));
    child.stdio[4].on('error', () => failAll('调试管道错误'));
    child.stdio[3].on('error', () => { /* 写端错误由 exit/close 处理，防 EPIPE 崩溃 */ });
    child.stdio[3].on('close', () => failAll('调试管道写端已关闭'));
    child.on('exit', () => failAll('浏览器进程已退出'));
    this.ready = Promise.resolve();
  }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    let idx;
    while ((idx = this.buf.indexOf(0)) !== -1) {
      const raw = this.buf.subarray(0, idx).toString('utf8');
      this.buf = this.buf.subarray(idx + 1);
      if (!raw.trim()) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`CDP ${msg.error.message}`)) : resolve(msg.result);
      }
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const m = { id, method, params };
    if (sessionId) m.sessionId = sessionId;
    this.child.stdio[3].write(JSON.stringify(m) + '\0');
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function pipeEval(pipe, expr, sessionId, label = '') {
  const r = await pipe.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`eval${label ? ' ' + label : ''}: ${d.exception?.description || d.text}`.slice(0, 800));
  }
  return r.result?.value;
}

const evalFn = (pipe, sessionId, fn, arg, label) =>
  pipeEval(pipe, `(${fn.toString()})(${JSON.stringify(arg ?? null)})`, sessionId, label);

/* ---------------- 浏览器启动 ---------------- */

function browserCandidates() {
  const local = (os.environ?.LOCALAPPDATA || '').replaceAll('\\', '/');
  const edge = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter((p) => p && fs.existsSync(p));
  const chrome = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',          // 品牌版走官方 pipe 通道
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${local}/Google/Chrome/Application/chrome.exe`,
  ].filter((p) => p && fs.existsSync(p));
  // PW_BROWSER=edge → Edge 优先（默认 Chrome 优先；品牌 Chrome 需走 pipe 通道加载扩展）
  if (process.env.PW_BROWSER === 'edge') return [...edge, ...chrome];
  return [...chrome, ...edge];
}

function killLeftoverTestBrowsers() {
  // 只清理命令行里带本测试 profile 的浏览器进程，不动用户正常开的浏览器
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*pw-e2e-profile*' } | Select-Object -ExpandProperty ProcessId"`,
      { encoding: 'utf8', timeout: 20000 },
    );
    for (const pid of out.split(/\s+/).filter((x) => /^\d+$/.test(x))) {
      try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch { /* ignore */ }
    }
    if (out.trim()) log('已清理遗留测试浏览器进程');
  } catch { /* 没有遗留进程 */ }
}

function makeProfile(wanted) {
  killLeftoverTestBrowsers();
  // 持久化 profile（按浏览器分开）：扩展装一次永久生效，后续启动自动加载
  PROFILE = PROFILE_BASE + '-' + wanted;
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: DL_ROOT, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: DL_ROOT },
    profile: { default_content_setting_values: { automatic_downloads: 1 } },
  }));
}

async function startBrowser(exe, wanted) {
  makeProfile(wanted);
  // Edge 管道启动偶发秒退：同一 profile 最多重试 3 次（扩展装过一次就永久生效）
  for (let t = 1; t <= 3; t++) {
    log(`启动 ${exe}（第 ${t} 次尝试）`);
    const child = spawn(exe, [
      `--user-data-dir=${PROFILE}`,
      `--remote-debugging-pipe`,
      `--enable-unsafe-extension-debugging`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--window-size=1300,900', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    const pipe = new PipeCDP(child);
    let exited = false;
    child.on('exit', () => { exited = true; });
    for (let i = 0; i < 40; i++) {
      try {
        await pipe.send('Target.getTargets');
        log('管道已响应');
        return { child, pipe };
      } catch {
        await sleep(400);
      }
      if (child.exitCode !== null || exited) break;
    }
    try { child.kill(); } catch { /* ignore */ }
    await sleep(1500);
  }
  throw new Error('浏览器调试管道未响应（重试 3 次）');
}

async function loadExtension(pipe) {
  const res = await pipe.send('Extensions.loadUnpacked', { path: EXT_DIR });
  if (!res?.id) throw new Error('Extensions.loadUnpacked 未返回 id: ' + JSON.stringify(res));
  log('扩展已加载, ID:', res.id);
  return res.id;
}

async function browserWsSetDownloadBehavior(pipe) {
  await pipe.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DL_ROOT,
    eventsEnabled: true
  });
}

/* ---------------- 目标 / 会话工具 ---------------- */

async function newTab(pipe, url) {
  const t = await pipe.send('Target.createTarget', { url });
  return t.targetId;
}

async function attach(pipe, targetId) {
  const r = await pipe.send('Target.attachToTarget', { targetId, flatten: true });
  return r.sessionId;
}

async function listTargets(pipe) {
  const r = await pipe.send('Target.getTargets');
  return r.targetInfos || [];
}

async function findSW(pipe, extId, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const infos = await listTargets(pipe);
    const sw = infos.find((x) => x.type === 'service_worker' && x.url === `chrome-extension://${extId}/background.js`);
    if (sw) return sw.targetId;
    await sleep(500);
  }
  throw new Error('找不到扩展 service worker');
}

async function waitPageReady(pipe, sessionId, timeoutMs = 120000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await evalFn(pipe, sessionId, () => ({
        ready: document.readyState,
        cards: document.querySelectorAll('article.post-card').length,
        post: !!document.querySelector('section.site-section--post'),
        title: document.title.slice(0, 80),
        cf: !!document.querySelector('#challenge-running, #challenge-form, .cf-turnstile, #cf-please-wait')
          || /just a moment|attention required/i.test(document.title),
      }));
    } catch { await sleep(1500); continue; }   // 上下文未就绪
    if (last && !last.cf && (last.cards > 0 || last.post)) return last;
    await sleep(1500);
  }
  throw new Error('页面未就绪（可能是 Cloudflare 挑战）：' + JSON.stringify(last));
}

/* ---------------- 扩展侧操作 ---------------- */

async function resetState(pipe, swSession) {
  await evalFn(pipe, swSession, () => {
    if (!globalThis.__e2eHook) {
      globalThis.__e2eHook = true;
      globalThis.__e2e = [];
      chrome.runtime.onMessage.addListener((m) => { globalThis.__e2e.push(m || null); });
    }
    globalThis.__e2e.length = 0;
    queue.length = 0;
    state.queued = 0; state.sent = 0; state.failed = 0;
    state.completed = 0; state.interrupted = 0; state.retried = 0; state.deduped = 0; state.throttled = 0;
    state.paused = false; state.pauseReason = '';
    if (typeof consecutiveJobFailures !== 'undefined') consecutiveJobFailures = 0;
    state.items.length = 0; state.lastError = '';
    // 清掉持久化队列（不清 doneSet：已完成文件跨作者去重）
    chrome.storage.local.remove('pawchiveDlQueue').catch?.(() => {}) ;
    return 'reset';
  }, null, 'resetState');
}

async function pollStatus(pipe, swSession) {
  return evalFn(pipe, swSession, () => {
    const msgs = globalThis.__e2e || [];
    const prog = msgs.filter((m) => m && m.type === 'pawchiveCrawlProgress');
    const posts = msgs.filter((m) => m && m.type === 'pawchivePost');
    const done = prog.find((m) => m.phase === 'done') || null;
    const last = prog[prog.length - 1] || null;
    return chrome.downloads.search({}).then((all) => {
      const active = all.filter((d) => d.state === 'in_progress').length;
      const doneCount = doneSet.size;   // 持久化完成数（SW 重启不失真）
      const failedItems = state.items.filter((i) => i.status === 'failed' || i.status === 'interrupted');
      return {
        q: queue.length,
        sent: state.sent, ok: state.completed, fail: state.failed + state.interrupted,
        retried: state.retried, throttled: state.throttled,
        active,
        doneCount,
        lastError: state.lastError,
        failedNames: failedItems.slice(-40).map((i) => i.filename),
        posts: posts.length,
        images: posts.reduce((n, m) => n + (m.payload?.images?.length || 0), 0),
        videos: posts.reduce((n, m) => n + (m.payload?.videos?.length || 0) + (m.payload?.links?.video?.length || 0), 0),
        txt: posts.filter((m) => (m.payload?.links?.drive?.length || 0) + (m.payload?.links?.video?.length || 0) + (m.payload?.links?.attach?.length || 0) > 0).length,
        pages: prog.filter((m) => m.phase === 'list').length,
        errors: prog.filter((m) => m.phase === 'listError' || m.phase === 'postError').length,
        done: done ? { posts: done.posts, skipped: done.skipped, failed: done.failed, cancelled: done.cancelled } : null,
        last: last ? { phase: last.phase, index: last.index, total: last.total, page: last.page } : null,
      };
    });
  }, null, 'pollStatus');
}

/* ---------------- 单作者流程 ---------------- */

async function attachSW(pipe, extId) {
  const swTarget = await findSW(pipe, extId);
  const sid = await attach(pipe, swTarget);
  try {
    await pipe.send('Runtime.enable', {}, sid);
    pipe.eventHandler = (msg) => {
      if (msg.sessionId !== sid) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        log('!! SW 异常:', (d.exception?.description || d.text || '').slice(0, 500));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        log('!! SW console.error:', JSON.stringify(msg.params.args).slice(0, 300));
      }
    };
  } catch (e) { /* ignore */ }
  return sid;
}

async function runAuthor(pipe, extId, url, index, total) {
  log(`===== [${index + 1}/${total}] ${url} =====`);
  const targetId = await newTab(pipe, url);
  const pageSession = await attach(pipe, targetId);
  try {
    const ready = await waitPageReady(pipe, pageSession);
    log('页面就绪:', JSON.stringify(ready));

    const meta = await evalFn(pipe, pageSession, () => ({
      artist: document.querySelector('meta[name="artist_name"]')?.content || '',
      h1: document.querySelector('h1.site-section__heading, .user-header__name')?.textContent?.trim() || '',
    }), null, 'meta');
    log('作者:', meta.artist || meta.h1 || '(未知)');

    let swSession = await attachSW(pipe, extId);
    await resetState(pipe, swSession);
    const dlBefore = await evalFn(pipe, swSession, () => doneSet.size, null, 'dlBefore');

    // 扫描列表页（content script 在 document_idle 注入，页面刚就绪时可能尚未完成 → 重试）
    const scan = await evalFn(pipe, swSession, async (authorUrl) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((x) => x.url === authorUrl)
        || tabs.find((x) => x.url && x.url.startsWith('https://pawchive.pw/') && x.url.includes('/user/'));
      if (!tab) return { error: '未找到 pawchive 标签页: ' + tabs.map((x) => x.url).join(' | ') };
      for (let k = 0; k < 15; k++) {
        try {
          return { tabId: tab.id, url: tab.url, scan: await chrome.tabs.sendMessage(tab.id, { type: 'pawchiveScan' }) };
        } catch (e) {
          if (k === 14) return { error: 'sendMessage 失败(重试15次): ' + String(e) };
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }, url, 'scan');
    if (scan.error || !scan.scan || scan.scan.kind !== 'cards') {
      throw new Error('扫描失败: ' + JSON.stringify(scan).slice(0, 400));
    }
    const { tabId } = scan;
    const s = scan.scan;
    log(`扫描: 本页 ${s.cards.length} 帖, 分页 maxOffset=${s.maxOffset}, 前3帖日期=${s.cards.slice(0, 3).map((c) => c.date).join(',')}`);

    // 启动爬取（全部翻页 + 分页器外续爬，重命名开启，无时间限制）
    const start = await evalFn(pipe, swSession, async (msg) => {
      try { return await chrome.tabs.sendMessage(msg.tabId, msg.payload); }
      catch (e) { return { error: String(e) }; }
    }, {
      tabId,
      payload: { type: 'pawchiveCrawl', scope: 'all', delay: DELAY_MS, limit: LIMIT, maxOffset: s.maxOffset || 0, dateFrom: '', dateTo: '', options: { rename: true, root: '' } },
    }, 'crawl');
    if (!start || !start.started) throw new Error('爬取启动失败: ' + JSON.stringify(start));
    log(`爬取已启动 (delay=${DELAY_MS}ms, rename=on, 全部分页+续爬)`);

    // 轮询直到完成（SW 会话断开时自动重连）
    const t0 = Date.now();
    let lastLine = '';
    let result = null;
    while (Date.now() - t0 < PER_AUTHOR_TIMEOUT_MS) {
      await sleep(5000);
      let st;
      try {
        st = await pollStatus(pipe, swSession);
      } catch (e) {
        log('!! poll 失败:', e.message.slice(0, 200));
        try { swSession = await attachSW(pipe, extId); } catch (e2) { /* ignore */ }
        continue;
      }
      const line = `进度: 收集页=${st.pages} ${st.last?.phase === 'post' ? `帖子=${st.last.index}/${st.last.total}` : ''} ` +
        `入队帖=${st.posts} 图=${st.images} 视频=${st.videos} txt=${st.txt} err=${st.errors} | 下载 队列=${st.q} 活动=${st.active} 发送=${st.sent} 完成=${st.ok} 失败=${st.fail}`;
      if (line !== lastLine) { log(line); lastLine = line; }
      if (st.done) {
        log(`爬取完成: 成功 ${st.done.posts} 帖, 跳过 ${st.done.skipped}, 失败 ${st.done.failed}${st.done.cancelled ? ' (手动停止)' : ''}`);
        // 等下载完全排空（队列空 + 无进行中下载 + 计数器连续 3 轮不变）
        let stable = 0;
        let prev = '';
        const d0 = Date.now();
        while (Date.now() - d0 < 60 * 60 * 1000) {
          await sleep(2000);
          let s2;
          try { s2 = await pollStatus(pipe, swSession); }
          catch { try { swSession = await attachSW(pipe, extId); } catch { /* ignore */ } continue; }
          const sig = `${s2.q}|${s2.active}|${s2.doneCount}`;
          if (s2.q === 0 && s2.active === 0 && sig === prev) stable++; else stable = 0;
          prev = sig;
          if (stable >= 3) { log(`下载排空: 完成=${s2.doneCount - dlBefore} 失败=${s2.fail}`); break; }
        }
        let fin = null;
        try { fin = await pollStatus(pipe, swSession); } catch { fin = st; }
        if (fin && fin.failedNames && fin.failedNames.length) {
          log(`失败文件 ${fin.failedNames.length} 个 (lastError=${fin.lastError})`);
          fin.failedNames.slice(0, 10).forEach((n) => log('   ✗', n));
        }
        result = {
          author: meta.artist || meta.h1 || '(未知)',
          scan: { cards: s.cards.length, maxOffset: s.maxOffset },
          crawl: st.done,
          dl: { sent: fin.sent, ok: Math.max(0, fin.doneCount - dlBefore), fail: fin.fail },
          posts: fin.posts, images: fin.images, videos: fin.videos, txt: fin.txt,
          failedNames: fin.failedNames || [],
          lastError: fin.lastError || '',
        };
        break;
      }
    }
    if (!result) throw new Error('单作者超时（60 分钟）');
    return result;
  } finally {
    try { await pipe.send('Target.closeTarget', { targetId }); } catch { /* ignore */ }
  }
}

/* ---------------- 入口 ---------------- */

(async () => {
  fs.mkdirSync(DL_ROOT, { recursive: true });
  const summary = { authors: [] };
  let pipe = null;
  let child = null;
  let swSession = null;
  let extId = null;

  // 被中断时也要杀掉浏览器，避免遗留实例并行抢配额
  const killChild = () => { try { child && child.kill(); } catch { /* ignore */ } };
  process.on('SIGINT', () => { killChild(); process.exit(130); });
  process.on('SIGTERM', () => { killChild(); process.exit(143); });
  process.on('uncaughtException', (e) => { console.error('UNCAUGHT', e); killChild(); process.exit(1); });

  const wanted = process.env.PW_BROWSER || 'chrome';
  log('指定测试浏览器:', wanted);

  // 1) 启动浏览器（持久化 profile：扩展装过就自动加载，无需每次 loadUnpacked）
  for (const exe of browserCandidates()) {
    const isEdge = exe.toLowerCase().includes('msedge');
    if (wanted === 'edge' && !isEdge) continue;        // 指定 Edge 时不尝试 Chrome
    if (wanted === 'chrome' && isEdge) continue;       // 指定 Chrome 时不尝试 Edge
    log('启动', exe);
    try {
      ({ child, pipe } = await startBrowser(exe, wanted));
      summary.browser = exe;
      break;
    } catch (e) {
      log(`!! ${exe} 启动失败: ${e.message}`);
      killChild();
      pipe = null; child = null;
    }
  }
  if (!pipe) throw new Error('所有候选浏览器都无法通过管道启动');
  log('下载目录 =>', DL_ROOT);

  try {
    // 2) 确认扩展已安装：profile 里有就直接用；没有才通过管道 loadUnpacked
    const prefsPath = path.join(PROFILE, 'Default', 'Preferences');
    let installed = false;
    try {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      const settings = prefs.extensions?.settings || {};
      for (const [k, v] of Object.entries(settings)) {
        const pp = String(v.path || '').toLowerCase().replaceAll('\\', '/');
        if (pp.endsWith('pawchive-downloader')) { installed = true; extId = k; break; }
      }
    } catch { /* ignore */ }
    if (installed) {
      log('扩展已在 profile 中安装, ID:', extId);
    } else {
      const load = await pipe.send('Extensions.loadUnpacked', { path: EXT });
      extId = load.result?.id;
      if (!extId) throw new Error('loadUnpacked 失败');
      log('扩展已加载, ID:', extId);
    }

    // 3) 等待 service worker 出现
    const swTarget = await findSW(pipe, extId, 30000);
    swSession = await attach(pipe, swTarget);
    log('service worker 已连接');
    await browserWsSetDownloadBehavior(pipe);
    log('下载目录 =>', DL_ROOT);

    for (let i = 0; i < AUTHORS.length; i++) {
      try {
        summary.authors.push({ url: AUTHORS[i], ...(await runAuthor(pipe, extId, AUTHORS[i], i, AUTHORS.length)) });
      } catch (e) {
        log(`!! 作者 ${i + 1} 失败:`, e.message);
        summary.authors.push({ url: AUTHORS[i], error: e.message });
      }
    }
    log('===== 汇总 =====');
    console.log(JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(EXT_DIR, 'test', 'e2e-result.json'), JSON.stringify(summary, null, 2));
    await pipe.send('Browser.close').catch(() => {});
  } finally {
    await sleep(1500);
    try { child.kill(); } catch { /* ignore */ }
  }
  process.exitCode = summary.authors.some((a) => a.error) ? 2 : 0;
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
