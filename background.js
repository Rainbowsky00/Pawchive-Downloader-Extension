// Load shared language helper (service worker only; skipped in test environments).
if (typeof importScripts === 'function') {
  try { importScripts('lang.js'); } catch (e) { /* ignore */ }
}
if (!globalThis.PawLang) {
  let __lang = 'en';
  try { __lang = (typeof navigator !== 'undefined' && navigator.language) || __lang; } catch (e) { /* ignore */ }
  try {
    if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) {
      __lang = navigator && navigator.language ? __lang : chrome.i18n.getUILanguage();
    }
  } catch (e) { /* ignore */ }
  const __lc = String(__lang || 'en').toLowerCase().replace(/_/g, '-');
  globalThis.PawLang = {
    lang: __lang,
    isZh: /^zh-(cn|hans|sg|my)(-|$)/.test(__lc),
    pick(zh, en) { return this.isZh ? zh : en; }
  };
}

// Localized string helper: Simplified Chinese -> zh, everything else -> en.
const T = (zh, en) => ((globalThis.PawLang && PawLang.isZh) ? zh : en);

/**
 * Pawchive Downloader - background service worker（v1.2.0 重写版）
 *
 * 设计原则：兼容所有 Chromium 浏览器（Chrome / Edge）。
 *  - 不使用 File System Access 写入器、不跨 Port 传 ArrayBuffer、不依赖 data: URL 作为主路径
 *  - 下载主路径 = chrome.downloads.download 直链下载（浏览器原生流式写入，
 *    文件名与目录结构在所有浏览器上行为一致）
 *  - 直链被站点拒绝（限流/0 字节）时，回退 fetch 字节 → data: URL 落地
 *  - 归档规则：下载目录/作者/年-月-日-标题/编号文件；网盘与视频链接写入 links.txt
 *
 * 可靠性：
 *  - 队列并发 2 + 每次派发间隔 3s（站点要求 ≤1 请求/秒、≤5 活动下载，此处保守）
 *  - 队列持久化：SW 重启/浏览器重开后自动恢复未完成任务
 *  - 已完成文件 uid 去重：重复爬取同一作者不会重复下载
 *  - 15s 心跳保活，防止 MV3 SW 空闲超时丢队列
 *  - 瞬时错误指数退避重试；连续 10 次失败自动暂停
 */

/* ---------------- DNR：修正数据面请求头（防站点热链拦截/限流误伤） ---------------- */

const DNR_RULE_ID = 1;

function setupDnr() {
  try {
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [DNR_RULE_ID],
      addRules: [{
        id: DNR_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            // 站方要求下载工具使用可识别 UA，且"装成浏览器会被封"
            { header: 'User-Agent', operation: 'set', value: 'PawchiveDownloader/1.5 (browser extension)' },
            // Chrome/Edge 会附加 Sec-CH-UA*/Sec-Fetch-* 客户端提示，与工具 UA 矛盾会触发 429，全部剥离
            { header: 'Sec-CH-UA', operation: 'remove' },
            { header: 'Sec-CH-UA-Mobile', operation: 'remove' },
            { header: 'Sec-CH-UA-Platform', operation: 'remove' },
            { header: 'Sec-Fetch-Site', operation: 'remove' },
            { header: 'Sec-Fetch-Mode', operation: 'remove' },
            { header: 'Sec-Fetch-Dest', operation: 'remove' },
            { header: 'Sec-Fetch-User', operation: 'remove' },
            { header: 'Accept', operation: 'set', value: '*/*' },
            { header: 'Referer', operation: 'set', value: 'https://pawchive.pw/' }
          ]
        },
        condition: {
          // 覆盖数据面：n*/data 永久文件、t*/f 临时签名文件；main_frame 必须包含（downloads 请求按主框架计算）
          regexFilter: '^https://[a-z0-9]+\\.pawchive\\.pw/(data|f)/',
          resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'image', 'media', 'other']
        }
      }]
    });
  } catch (e) { /* ignore */ }
}

setupDnr();
chrome.runtime.onInstalled.addListener(setupDnr);
chrome.runtime.onStartup.addListener(setupDnr);

/* ---------------- 文件名兜底：onDeterminingFilename ----------------
 * Chromium（Chrome / Edge）有一个长期未修复的行为：只要有任意扩展注册了
 * chrome.downloads.onDeterminingFilename，downloads.download() 传入的 filename
 * 就会被丢弃，改用 URL / Content-Disposition 推导出的名字（子目录也一起丢失）。
 * 常见的下载管理器类扩展（IDM、Bulk Image Downloader 等）都会注册该监听，
 * 这就是 Edge 里"重命名规则全部失效、文件全部堆到下载根目录"的根因。
 *
 * 修复：本扩展也注册该监听，只对自己发起的下载重新 suggest 目标路径；
 * 其他扩展的下载用 suggest() 保持默认，不做干预。
 * 多个扩展都给出建议时，Chromium 采用"最后安装的扩展"的建议。
 */
const pendingFilenameByUrl = new Map();   // url -> [目标相对路径, ...]（按发起顺序 FIFO）

function rememberFilename(url, filename) {
  if (!url || !filename) return;
  const arr = pendingFilenameByUrl.get(url);
  if (arr) arr.push(filename);
  else pendingFilenameByUrl.set(url, [filename]);
}

function forgetFilename(url, filename) {
  const arr = pendingFilenameByUrl.get(url);
  if (!arr) return;
  const i = arr.indexOf(filename);
  if (i >= 0) arr.splice(i, 1);
  if (!arr.length) pendingFilenameByUrl.delete(url);
}

function consumeFilename(url) {
  const arr = pendingFilenameByUrl.get(url);
  if (!arr || !arr.length) return '';
  const f = arr.shift();
  if (!arr.length) pendingFilenameByUrl.delete(url);
  return f;
}

// 下载完成后核对真实落点：若被其他扩展的命名建议覆盖，记录诊断（便于排查）
function noteNameCheck(actualPath, expected) {
  if (!actualPath || !expected) return;
  const norm = String(actualPath).replace(/\\/g, '/');
  const want = String(expected).replace(/\\/g, '/');
  if (!norm.endsWith('/' + want)) {
    state.namingConflict = true;
    pushDiag({ type: 'naming', filename: want, actual: norm });
  }
}

// Chromium 的规则：多扩展同时建议文件名时，“最后安装的扩展”胜出。
// 本插件安装时间晚于常见的下载管理器扩展时即可正常命名；若被抢占，
// 弹窗/监控小窗会提示「文件名被其他扩展改写」。
try {
  if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
    chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
      const want = consumeFilename(item && item.url);
      if (want) suggest({ filename: want, conflictAction: 'overwrite' });
      else suggest();   // 非本扩展发起的下载：接受默认命名
    });
  }
} catch (e) { /* 浏览器不支持该事件时忽略 */ }

/* ---------------- 命名工具 ---------------- */

// 去掉所有 emoji（含连字 ZWJ、变体选择符、肤色、键帽等）
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

function stripEmoji(s) {
  return (s || '').replace(EMOJI_RE, '').replace(/[\u200B-\u200F\u202A-\u202E]/g, '');
}

function sanitizeText(s, maxLen) {
  let out = stripEmoji(String(s || ''));
  out = out.replace(/[\\/:*?"<>|]/g, ' ');      // Windows 非法字符替换为空格
  out = out.replace(/[\u0000-\u001F\u007F]/g, '');
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/[.\s]+$/, '');
  if (maxLen && out.length > maxLen) out = out.slice(0, maxLen).replace(/[.\s]+$/, '');
  return out;
}

function sanitizePathSegment(s) {
  return String(s || '')
    .split(/[\\/]+/)
    .map((p) => sanitizeText(p, 120))
    .filter((p) => p && p !== '.' && p !== '..');
}

function joinPath(parts) {
  return parts.flatMap((p) => sanitizePathSegment(p)).join('/');
}

// 补零规则：宽度 = 总数的位数（≤9 → 1..9；10-99 → 01..；100-999 → 001..）
function padIndex(i, total) {
  return String(i).padStart(String(total).length, '0');
}

function urlBasename(u) {
  try {
    const url = new URL(u);
    const f = url.searchParams.get('f');
    if (f) return f;
    const seg = url.pathname.split('/').filter(Boolean);
    return seg.length ? decodeURIComponent(seg[seg.length - 1]) : '';
  } catch (e) { return ''; }
}

function urlExt(u, fallback) {
  const base = urlBasename(u) || '';
  const m = /\.([a-z0-9]{1,5})$/i.exec(base);
  return m ? m[1].toLowerCase() : (fallback || '');
}

function sanitizeFilename(name, fallbackBase, fallbackExt) {
  let n = sanitizeText(String(name || ''), 150);
  if (!n) n = `${fallbackBase}.${fallbackExt}`;
  return n;
}

/* ---------------- 持久化与去重 ---------------- */

const QUEUE_KEY = 'pawchiveDlQueue';
const DONE_KEY = 'pawchiveDlDone';
const FOLDER_KEY = 'pawchiveFolderOwner';   // folderPath -> postId，防止不同帖子同名串档
const OPTS_KEY = 'pawchiveLastOptions';     // 最近一次使用的选项（兜底）

const doneSet = new Set();
const pendingSet = new Set();               // 排队中 + 在途的 uid（防止重复入队）
const queue = [];
let folderOwner = {};
let lastOptions = { rename: true, root: '', scope: 'all', limit: 0, dateFrom: '', dateTo: '' };

let persistTimer = null;
let doneDirty = [];
let doneTimer = null;
let folderTimer = null;

function jobUid(job) {
  // txt 的 dataUrl 含导出时间，用目标路径作为 uid 才能跨次运行去重
  if (job.kind === 'txt') return 'T' + job.filename;
  return 'U' + (job.url || '') + '>' + job.filename;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chrome.storage.local.set({ [QUEUE_KEY]: queue.map((j) => ({ ...j })) }).catch(() => {});
  }, 400);
}

function markDone(uid) {
  doneSet.add(uid);
  doneDirty.push(uid);
  if (doneTimer) return;
  doneTimer = setTimeout(() => {
    doneTimer = null;
    const batch = doneDirty;
    doneDirty = [];
    chrome.storage.local.get(DONE_KEY).then(({ [DONE_KEY]: prev = [] }) =>
      chrome.storage.local.set({ [DONE_KEY]: prev.concat(batch).slice(-5000) })
    ).catch(() => {});
  }, 1000);
}

function scheduleFolderPersist() {
  if (folderTimer) return;
  folderTimer = setTimeout(() => {
    folderTimer = null;
    chrome.storage.local.set({ [FOLDER_KEY]: folderOwner }).catch(() => {});
  }, 800);
}

function refreshNextPending() {
  state.nextPending = queue.slice(0, 15).map((j) => j.filename);
}

/* ---------------- 状态 ---------------- */

const state = {
  running: false,
  paused: false,
  pauseReason: '',
  queued: 0,
  sent: 0,
  failed: 0,
  completed: 0,
  interrupted: 0,
  retried: 0,
  throttled: 0,
  cooldownUntil: 0,
  deduped: 0,
  namingConflict: false, // 有其他扩展覆盖了本扩展的文件名建议
  lastError: '',
  items: [],           // 最近的任务 {filename, kind, status}
  active: [],          // 在途任务 [{filename, received, total}]
  nextPending: [],     // 接下来要下载的文件名（前 15 个）
  diag: []             // 诊断记录（每个任务的实际执行结果）
};

const failedJobs = [];
const DIAG_MAX = 40;
function pushDiag(entry) {
  entry.t = new Date().toLocaleTimeString();
  state.diag.push(entry);
  if (state.diag.length > DIAG_MAX) state.diag.shift();
}
const activeCancels = new Map();   // key -> 取消函数（暂停/停止时立即中断在途下载）
let cancelSeq = 0;

function registerActiveCancel(key, fn) { activeCancels.set(key, fn); }
function unregisterActiveCancel(key) { activeCancels.delete(key); }
function cancelActiveDownloads() {
  for (const fn of activeCancels.values()) {
    try { fn(); } catch (e) { /* ignore */ }
  }
  activeCancels.clear();
}

// 爬取所在标签页（停止类操作时一并取消爬取）
let crawlTabId = null;
function cancelCrawl() {
  if (crawlTabId !== null) {
    try { chrome.tabs.sendMessage(crawlTabId, { type: 'pawchiveCrawlCancel' }).catch?.(() => {}); } catch (e) { /* ignore */ }
  }
}

/* ---------------- SW 启动：恢复队列 / 完成标记 / 选项 ---------------- */

// 旧版本（v1.4.x）的自定义保存目录已移除，清理遗留键
chrome.storage.local.remove(['customDirName']).catch(() => {});

// 站点临时链接形如 ...&e=<unix秒>&s=<签名>；过期的链接重试也没用，恢复队列时直接丢弃
function isExpiredJob(job) {
  try {
    const u = new URL(job.url);
    const e = u.searchParams.get('e');
    if (!e || !/^\d+$/.test(e)) return false;
    return Number(e) * 1000 < Date.now() - 60e3;
  } catch (e) { return false; }
}

chrome.storage.local.get([QUEUE_KEY, DONE_KEY, FOLDER_KEY, OPTS_KEY]).then((vals) => {
  const saved = vals[QUEUE_KEY] || [];
  (vals[DONE_KEY] || []).forEach((u) => doneSet.add(u));
  if (vals[FOLDER_KEY] && typeof vals[FOLDER_KEY] === 'object') folderOwner = vals[FOLDER_KEY];
  if (vals[OPTS_KEY] && typeof vals[OPTS_KEY] === 'object') lastOptions = vals[OPTS_KEY];
  if (Array.isArray(saved) && saved.length) {
    let resumed = 0;
    let expired = 0;
    for (const j of saved) {
      if (!j || !j.filename) continue;
      if (doneSet.has(jobUid(j))) continue;
      if (!j.dataUrl && isExpiredJob(j)) { expired++; continue; }
      queue.push(j);
      resumed++;
    }
    chrome.storage.local.set({ [QUEUE_KEY]: [] }).catch(() => {});
    if (expired) {
      pushDiag({ type: 'skipped', detail: T(`${expired} 个旧任务的下载链接已过期，已丢弃；请重新爬取该帖子`, `${expired} old tasks had expired download links and were dropped; re-crawl the post`) });
      state.lastError = T(`${expired} 个旧任务的链接已过期，请重新爬取`, `${expired} old tasks had expired links; re-crawl the post`);
    }
    if (resumed) pump();
  }
}).catch(() => {});

/* ---------------- 队列与下载 ---------------- */

const CONCURRENCY = 2;    // 站方要求 ≤5 个活动下载，取保守值
// 站方要求 ≤1 请求/秒；实测持续 1/s 会触发 429，取 3s 更稳
const BASE_INTERVAL_MS = globalThis.__pwTestFast ? 5 : 3000;
const MAX_INTERVAL_MS = 12000;
const COOLDOWN_STEPS = [60e3, 180e3, 300e3];
const JOB_TIMEOUT_MS = { image: 3 * 60e3, txt: 60e3, video: 20 * 60e3 };
const MAX_ATTEMPTS = 5;
const PAUSE_AFTER_FAILS = 10;

let dispatchInterval = BASE_INTERVAL_MS;
let nextSlotAt = 0;
let consecutiveOk = 0;
let cooldownIndex = 0;
let consecutiveJobFailures = 0;
let pumping = false;
let heartbeat = null;
let lastDispatch = 0;
let controlGen = 0;   // 控制代：暂停/停止/重置时递增，使在途任务感知控制变化

function noteRateLimited() {
  consecutiveOk = 0;
  dispatchInterval = Math.min(MAX_INTERVAL_MS, Math.round(dispatchInterval * 1.5));
  const cool = COOLDOWN_STEPS[Math.min(cooldownIndex, COOLDOWN_STEPS.length - 1)];
  cooldownIndex++;
  nextSlotAt = Math.max(nextSlotAt, Date.now() + cool);
  state.throttled++;
  state.cooldownUntil = nextSlotAt;
}

function noteSuccess() {
  if (++consecutiveOk >= 15) {
    consecutiveOk = 0;
    cooldownIndex = 0;
    if (dispatchInterval > BASE_INTERVAL_MS) {
      dispatchInterval = Math.max(BASE_INTERVAL_MS, Math.round(dispatchInterval / 1.3));
    }
  }
}

function enqueueJob(job) {
  const uid = jobUid(job);
  if (doneSet.has(uid) || pendingSet.has(uid)) { state.deduped++; return; }
  pendingSet.add(uid);
  queue.push(job);
  state.queued++;
  refreshNextPending();
  schedulePersist();
}

function ensureHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    if (!queue.length && !pumping) {
      clearInterval(heartbeat);
      heartbeat = null;
      return;
    }
    try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) { /* ignore */ }
  }, 15000);
}

async function pump() {
  if (pumping) return;
  pumping = true;
  state.running = true;
  ensureHeartbeat();
  const inflight = new Set();
  while (queue.length || inflight.size) {
    if (state.paused) break;
    while (queue.length && inflight.size < CONCURRENCY) {
      const wait = Math.max(nextSlotAt, lastDispatch + dispatchInterval) - Date.now();
      if (wait > 0) await sleepMs(wait);
      if (!queue.length || state.paused) break;
      const job = queue.shift();
      lastDispatch = Date.now();
      state.queued = queue.length;
      refreshNextPending();
      schedulePersist();
      const p = downloadJob(job).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    if (inflight.size) await Promise.race(inflight);
  }
  state.running = false;
  pumping = false;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// 直链下载：主路径。完成后由调用方查询权威字节数（0 字节 → 回退）
function attemptDownload(job) {
  return new Promise((resolve) => {
    const item = { filename: job.filename, kind: job.kind, status: 'sending', id: null };
    pushItem(item);
    let settled = false;
    let onChange = null;
    let cap = null;
    const finish = (outcome, error) => {
      if (settled) return;
      settled = true;
      if (onChange) chrome.downloads.onChanged.removeListener(onChange);
      if (cap) clearTimeout(cap);
      if (item.id !== null) unregisterActiveCancel('dl' + item.id);
      resolve({ outcome, error, id: item.id });
    };
    cap = setTimeout(() => finish('timeout'), JOB_TIMEOUT_MS[job.kind] || 3 * 60e3);
    rememberFilename(job.url, job.filename);   // onDeterminingFilename 兜底用
    try {
      chrome.downloads.download({
        url: job.url,
        filename: job.filename,
        conflictAction: 'overwrite',   // 目录按帖子隔离，覆盖安全
        saveAs: false
      }, (id) => {
        if (chrome.runtime.lastError || id === undefined) {
          forgetFilename(job.url, job.filename);
          item.status = 'failed';
          state.lastError = (chrome.runtime.lastError && chrome.runtime.lastError.message) || T('download() 返回空', 'download() returned no id');
          finish('accept-failed', state.lastError);
          return;
        }
        item.id = id;
        item.status = 'downloading';
        registerActiveCancel('dl' + id, () => { try { chrome.downloads.cancel(id); } catch (e) { /* ignore */ } });
        const onState = (st, error) => {
          if (st === 'complete') { item.status = 'done'; finish('complete'); }
          else if (st === 'interrupted') { item.status = 'interrupted'; item.error = error || ''; finish('interrupted', error || ''); }
        };
        onChange = (delta) => {
          if (delta.id !== id || !delta.state) return;
          onState(delta.state.current, delta.error && delta.error.current);
        };
        chrome.downloads.onChanged.addListener(onChange);
        // 兜底：完成/失败可能早于监听注册（秒完成、秒拒）
        try {
          chrome.downloads.search({ id }, (items) => {
            const it = items && items[0];
            if (it && !settled) onState(it.state, it.error);
          });
        } catch (e) { /* ignore */ }
      });
    } catch (e) {
      forgetFilename(job.url, job.filename);
      item.status = 'failed';
      state.lastError = String(e);
      finish('accept-failed', String(e));
    }
  });
}

/* ---------------- Offscreen 文档：Blob URL 下载（跨浏览器文件名可靠） ---------------- */

let offscreenCreating = null;

async function ensureOffscreen() {
  const has = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')]
  }).then((ctxs) => ctxs.length > 0).catch(() => false);
  if (has) return true;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Use a Blob URL so the requested filename is honored across browsers'
    }).then(() => true).catch((e) => {
      offscreenCreating = null;
      if (String(e && e.message || e).includes('single')) return true;   // 已存在
      return false;
    });
  }
  return offscreenCreating;
}

let blobSaveSeq = 0;

// 通过 offscreen 文档生成 Blob URL，再由后台统一发起下载。
// 这样文件名建议只由本扩展 SW 里的 onDeterminingFilename 监听器给出，
// 避免 offscreen 页面再注册监听导致同一扩展内多个监听互相覆盖。
async function saveViaOffscreen(b64, mime, filename) {
  const ok = await ensureOffscreen();
  if (!ok) return { ok: false, unavailable: true };
  try {
    const res = await chrome.runtime.sendMessage({ type: 'pwSaveBlob', id: ++blobSaveSeq, b64, mime, filename });
    return res || { ok: false, error: T('offscreen 无响应', 'offscreen did not respond') };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// 回退路径：fetch 字节 → data: URL → downloadLocal
function downloadLocal(dataUrl, filename) {
  return new Promise((resolve) => {
    let settled = false;
    let onChange = null;
    let locId = null;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (onChange) chrome.downloads.onChanged.removeListener(onChange);
      if (locId !== null) unregisterActiveCancel('loc' + locId);
      resolve(res);
    };
    try {
      rememberFilename(dataUrl, filename);   // onDeterminingFilename 兜底用
      chrome.downloads.download({
        url: dataUrl, filename, conflictAction: 'overwrite', saveAs: false
      }, (id) => {
        if (chrome.runtime.lastError || id === undefined) {
          forgetFilename(dataUrl, filename);
          finish({ ok: false, acceptError: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'unknown' });
          return;
        }
        locId = id;
        registerActiveCancel('loc' + id, () => { try { chrome.downloads.cancel(id); } catch (e) { /* ignore */ } });
        const onState = (st, error) => {
          if (st === 'complete') {
            try {
              chrome.downloads.search({ id }, (items) => {
                const it = items && items[0];
                if (it) noteNameCheck(it.filename, filename);
                finish({ ok: true });
              });
              return;
            } catch (e) { /* ignore */ }
            finish({ ok: true });
          } else if (st === 'interrupted') finish({ ok: false, acceptError: error || 'interrupted' });
        };
        onChange = (delta) => {
          if (delta.id !== id || !delta.state) return;
          onState(delta.state.current, delta.error && delta.error.current);
        };
        chrome.downloads.onChanged.addListener(onChange);
        // 兜底：完成可能早于监听注册
        try {
          chrome.downloads.search({ id }, (items) => {
            const it = items && items[0];
            if (it && !settled) onState(it.state, it.error);
          });
        } catch (e) { /* ignore */ }
      });
    } catch (e) {
      forgetFilename(dataUrl, filename);
      finish({ ok: false, acceptError: String(e) });
    }
  });
}

// fetch 流式读取（回退路径用）：分块回调 onChunk(Uint8Array)
async function fetchBytes(job, onChunk, onProgress) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180e3);
  try {
    const res = await fetch(job.url, { credentials: 'omit', signal: ac.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const total = Number(res.headers.get('content-length')) || 0;
    const mime = res.headers.get('content-type') || 'application/octet-stream';
    let received = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await onChunk(value);
        received += value.byteLength;
        if (onProgress) onProgress(received, total);
      }
    } else {
      const buf = await res.arrayBuffer();
      await onChunk(new Uint8Array(buf));
      received = buf.byteLength;
      if (onProgress) onProgress(received, total);
    }
    return { ok: true, received, total, mime };
  } catch (e) {
    return { ok: false, networkError: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// 回退：fetch 全量字节 → offscreen Blob URL 保存（跨浏览器文件名可靠）
async function fetchAndSave(job, onProgress) {
  const chunks = [];
  const r = await fetchBytes(
    job,
    (chunk) => { chunks.push(chunk); },
    (n, t) => onProgress && onProgress(n, t)
  );
  if (!r.ok) return r;
  if (r.received > 64 * 1024 * 1024) return { ok: false, tooBig: true };
  let all;
  if (chunks.length === 1) all = chunks[0];
  else {
    all = new Uint8Array(r.received);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  }
  const saved = await saveViaOffscreen(bytesToBase64(all), r.mime, job.filename);
  if (saved.ok) return { ok: true, bytes: r.received };
  // offscreen 不可用 → data: URL 最后手段
  const dataUrl = `data:${r.mime};base64,${bytesToBase64(all)}`;
  const dlRes = await downloadLocal(dataUrl, job.filename);
  return dlRes.ok ? { ok: true, bytes: r.received } : dlRes;
}

const TRANSIENT_ERR_RE = /(NETWORK_|SERVER_UNREACHABLE|SERVER_FORBIDDEN|SERVER_TIMEOUT|SERVER_CONTENT_LENGTH_MISMATCH|SERVER_FAILED|CRASH)/;

// 单个任务：直链主路径 + fetch-save 回退 + 瞬时错误退避重试
async function downloadJob(job) {
  const uid = jobUid(job);
  const gen = controlGen;                      // 捕获控制代（暂停/停止/重置会递增）
  const activeEntry = { filename: job.filename, received: 0, total: 0 };
  state.active.push(activeEntry);
  let requeued = false;
  try {
    for (let attempt = 1; ; attempt++) {
      let outcome = null;      // 'complete' | 'transient' | 'fatal'
      let errMsg = '';
      const progressCb = (received, total) => {
        activeEntry.received = received;
        activeEntry.total = total;
      };

      if (job.dataUrl) {
          // txt 等本地内容：data: URL 落地（内容就在本地，无网络请求）
          const r = await downloadLocal(job.dataUrl, job.filename);
          if (r.ok) outcome = 'complete';
          else if (TRANSIENT_ERR_RE.test(r.acceptError || '') || gen !== controlGen) { outcome = 'transient'; errMsg = r.acceptError; }
          else { outcome = 'fatal'; errMsg = r.acceptError || T('data URL 落地失败', 'data URL save failed'); }
        } else {
          // 主路径：直链下载
          const r = await attemptDownload(job);
          if (r.outcome === 'complete') {
            // 校验权威字节数：0 字节 = 站点拒绝 → 删除后走 fetch-save 回退
          const item = await new Promise((res) =>
            chrome.downloads.search({ id: r.id }, (arr) => res((arr && arr[0]) || null)));
          activeEntry.via = T('直链', 'direct');
          if (item) noteNameCheck(item.filename, job.filename);
          if (item && item.bytesReceived === 0) {
            try { await chrome.downloads.removeFile(r.id); } catch (e) { /* ignore */ }
            try { await chrome.downloads.erase({ id: r.id }); } catch (e) { /* ignore */ }
            const fetched = await fetchAndSave(job, progressCb);
            if (fetched.ok) outcome = 'complete';
            else if (fetched.networkError || fetched.acceptError) { outcome = 'transient'; errMsg = fetched.networkError || fetched.acceptError; }
            else if (typeof fetched.status === 'number') {
              outcome = (fetched.status === 404 || fetched.status === 410) ? 'fatal' : 'transient';
              errMsg = `HTTP ${fetched.status}`;
            } else { outcome = 'transient'; errMsg = 'fetch failed'; }
          } else {
            outcome = 'complete';
          }
          if (activeEntry.via !== T('直链+回退', 'direct+fallback') && item && item.bytesReceived === 0) activeEntry.via = T('直链', 'direct');
        } else if (r.outcome === 'timeout') {
          // 超时：下载仍在进行，交由管理器收尾
          outcome = 'complete';
        } else if (r.outcome === 'interrupted' && (gen !== controlGen || (TRANSIENT_ERR_RE.test(r.error || '') && !r.error.includes('SERVER_BAD_CONTENT')))) {
          // 直链被站点拒绝/网络错误 → fetch-save 回退（fetch 头部修正更彻底）
          const fetched = await fetchAndSave(job, progressCb);
          if (fetched.ok) { outcome = 'complete'; activeEntry.via = T('直链+回退', 'direct+fallback'); }
          else if (fetched.networkError || fetched.acceptError) { outcome = 'transient'; errMsg = fetched.networkError || fetched.acceptError; }
          else if (typeof fetched.status === 'number') {
            outcome = (fetched.status === 404 || fetched.status === 410) ? 'fatal' : 'transient';
            errMsg = `HTTP ${fetched.status}`;
          } else { outcome = 'transient'; errMsg = 'fetch failed'; }
        } else {
          outcome = (r.outcome === 'accept-failed' || r.outcome === 'interrupted') ? 'fatal' : 'transient';
          errMsg = r.error || r.outcome;
        }
      }

      if (outcome === 'complete') {
        // 停止前已完成的文件照常计数与标记（文件已落盘）
        state.sent++; state.completed++; consecutiveJobFailures = 0;
        markDone(uid); noteSuccess();
        pushDiag({ type: 'done', filename: job.filename, bytes: activeEntry.received, via: activeEntry.via || T('直链', 'direct') });
        return;
      }
      // 暂停/停止/重置后：不再重试，也不再计失败
      if (gen !== controlGen) {
        if (state.paused && !state.stopped) {
          // 暂停：未完成任务放回队列头部，续传时重下
          queue.unshift(job);
          state.queued = queue.length;
          requeued = true;
          refreshNextPending();
        }
        pushItem({ filename: job.filename, kind: job.kind, status: state.paused ? 'sending' : 'failed' });
        pushDiag({ type: state.paused ? 'paused' : 'discarded', filename: job.filename });
        return;
      }
      if (outcome === 'transient') noteRateLimited();
      if (outcome === 'fatal' || attempt >= MAX_ATTEMPTS) {
        state.sent++; state.failed++;
        state.lastError = errMsg || 'download failed';
        failedJobs.push({ filename: job.filename, error: state.lastError });
        if (failedJobs.length > 100) failedJobs.shift();
        pushDiag({ type: 'failed', filename: job.filename, error: state.lastError, bytes: activeEntry.received });
        if (++consecutiveJobFailures >= PAUSE_AFTER_FAILS && !state.paused) {
          // 连续失败说明站点在整体限流：暂停队列（剩余任务已持久化，可稍后继续）
          state.paused = true;
          state.pauseReason = state.lastError;
          schedulePersist();
        }
        return;
      }
      // 瞬时错误 → 指数退避重试
      state.retried++;
      pushItem({ filename: job.filename, kind: job.kind, status: 'retry' });
      await sleepMs((2 ** (attempt - 1)) * 10e3);
    }
  } finally {
    const i = state.active.indexOf(activeEntry);
    if (i >= 0) state.active.splice(i, 1);
    pendingSet.delete(uid);
    refreshNextPending();
  }
}

function pushItem(item) {
  state.items.push(item);
  if (state.items.length > 300) state.items.splice(0, state.items.length - 300);
}

/* ---------------- links.txt 生成 ---------------- */

function buildTxt(payload) {
  const L = [];
  L.push(`${T('帖子', 'Post')}: ${payload.title || payload.postId || T('(无标题)', '(untitled)')}`);
  L.push(`${T('作者', 'Author')}: ${payload.author || T('(未知)', '(unknown)')}`);
  L.push(`${T('日期', 'Date')}: ${payload.date || T('(未知)', '(unknown)')}`);
  L.push(`${T('页面', 'Page')}: ${payload.pageUrl}`);
  L.push(`${T('导出时间', 'Exported')}: ${new Date().toLocaleString()}`);
  const section = (title, entries) => {
    if (!entries || !entries.length) return;
    L.push('', `${T('【', '[')}${title}${T('】', ']')} (${entries.length})`);
    entries.forEach((e) => {
      const url = typeof e === 'string' ? e : e.url;
      const name = typeof e === 'string' ? '' : (e.filename ? `  (${e.filename})` : '');
      L.push(`- ${url}${name}`);
    });
  };
  section(T('云盘链接', 'Cloud storage links'), payload.links && payload.links.drive);
  section(T('视频链接', 'Video links'), payload.links && payload.links.video);
  section(T('其他附件', 'Other attachments'), payload.links && payload.links.attach);
  return L.join('\r\n') + '\r\n';
}

/* ---------------- 入队一个帖子 ---------------- */

// 同日期+标题但不同帖子 → 加 [postId] 后缀，避免文件混档
function resolveFolder(baseFolder, postId) {
  const pid = String(postId || '');
  if (!pid) return baseFolder;
  const owner = folderOwner[baseFolder];
  if (!owner || owner === pid) {
    if (!owner) { folderOwner[baseFolder] = pid; scheduleFolderPersist(); }
    return baseFolder;
  }
  for (let k = 1; k < 50; k++) {
    const cand = `${baseFolder} [${pid}${k > 1 ? '-' + k : ''}]`;
    const o2 = folderOwner[cand];
    if (!o2 || o2 === pid) {
      if (!o2) { folderOwner[cand] = pid; scheduleFolderPersist(); }
      return cand;
    }
  }
  return `${baseFolder} [${pid}]`;
}

function enqueuePost(payload, options) {
  if (!payload || payload.kind !== 'post') return { error: T('无效的帖子数据', 'Invalid post data') };
  const opts = options || lastOptions || {};
  const rename = opts.rename !== false;            // 默认开启重命名
  const root = opts.root || '';

  const author = sanitizeText(payload.author, 80) || 'unknown-author';
  const titlePart = sanitizeText(payload.title, 80) || `post-${payload.postId || Date.now()}`;
  const sub = payload.date ? `${payload.date}-${titlePart}` : titlePart;
  const baseFolder = joinPath([root, author, sub]);
  const folder = resolveFolder(baseFolder, payload.postId);

  // 统一媒体顺序：Files 区出现顺序（图片+视频混排）+ 正文内嵌视频
  let ordered = Array.isArray(payload.media) && payload.media.length
    ? payload.media.slice()
    : [
        ...(payload.images || []).map((i) => ({ ...i, kind: 'image' })),
        ...(payload.videos || []).map((v) => ({ ...v, kind: 'video', ext: v.ext || urlExt(v.url, 'mp4') })),
      ];
  const inMedia = new Set(ordered.map((m) => m.url));
  (payload.videos || []).forEach((v) => { if (v && v.url && !inMedia.has(v.url)) ordered.push({ ...v, kind: 'video', ext: v.ext || urlExt(v.url, 'mp4') }); });
  ((payload.links && payload.links.video) || []).forEach((v) => { if (v && v.url && !inMedia.has(v.url)) ordered.push({ ...v, kind: 'video' }); });
  const seenAll = new Set();
  ordered = ordered.filter((m) => (m && m.url && !seenAll.has(m.url)) ? (seenAll.add(m.url), true) : false);

  let added = 0;

  ordered.forEach((m, i) => {
    if (rename) {
      // 统一编号：1 / 01 / 001（扩展名保留），文件夹内不出现任何原始文件名
      const ext = sanitizeText(m.ext || urlExt(m.url, 'bin'), 8) || 'bin';
      enqueueJob({ url: m.url, filename: `${folder}/${padIndex(i + 1, ordered.length)}.${ext}`, kind: m.kind || 'image' });
    } else {
      const base = m.filename || urlBasename(m.url) || `file-${i + 1}`;
      const ext = m.ext || urlExt(m.url, 'bin');
      enqueueJob({ url: m.url, filename: `${folder}/${sanitizeFilename(base, `file-${i + 1}`, ext)}`, kind: m.kind || 'image' });
    }
    added++;
  });

  // 网盘 / 视频链接 / 附件 → links.txt
  const links = payload.links || {};
  if ((links.drive && links.drive.length) || (links.video && links.video.length) || (links.attach && links.attach.length)) {
    const txt = buildTxt(payload);
    const b64 = bytesToBase64(new TextEncoder().encode(txt));
    enqueueJob({
      kind: 'txt',
      b64,
      mime: 'text/plain',
      dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(txt),   // 回退用
      filename: `${folder}/links.txt`
    });
    added++;
  }

  if (added > 0) {
    pushDiag({ type: 'queued', filename: folder + '/ (' + added + T(' 个任务', ' tasks') + ')' });
    openMonitor(false);
  }
  pump();
  return { ok: true, folder, images: (payload.images || []).length, videos: (payload.videos || []).length, jobs: added };
}

/* ---------------- 控制：暂停 / 继续 / 结束 / 重置 ---------------- */

function doPauseQueue() {
  controlGen++;
  state.paused = true;
  pushDiag({ type: 'action', detail: T('暂停下载（在途已中断）', 'Pause requested (in-flight downloads cancelled)') });
  state.pauseReason = T('手动暂停', 'manual pause');
  cancelActiveDownloads();   // 立即中断在途下载（中断的任务重新入队，续传时重下）
  schedulePersist();
  return { ok: true, queued: queue.length };
}

function doResumeQueue() {
  state.paused = false;
  pushDiag({ type: 'action', detail: T('继续下载', 'Resume requested') });
  state.pauseReason = '';
  consecutiveJobFailures = 0;
  cooldownIndex = 0;
  dispatchInterval = BASE_INTERVAL_MS;
  nextSlotAt = 0;
  pump();
  return { ok: true, queued: queue.length };
}

function doStopQueue() {
  controlGen++;
  pushDiag({ type: 'action', detail: T('结束下载（队列已清空）', 'Stop requested (queue cleared)') });
  queue.length = 0;
  pendingSet.clear();
  state.queued = 0;
  state.paused = false;
  state.pauseReason = '';
  cancelActiveDownloads();            // 立即中断在途下载（被停止的任务直接丢弃）
  cancelCrawl();                      // 一并取消爬取
  chrome.storage.local.remove(QUEUE_KEY).catch(() => {});
  refreshNextPending();
  return { ok: true, stopped: true };
}

function doResetRecords() {
  controlGen++;
  pushDiag({ type: 'action', detail: T('清空下载记录', 'Download records cleared') });
  doneSet.clear();
  folderOwner = {};
  queue.length = 0;
  pendingSet.clear();
  cancelActiveDownloads();
  cancelCrawl();
  state.queued = 0; state.sent = 0; state.failed = 0;
  state.completed = 0; state.interrupted = 0;
  state.retried = 0; state.throttled = 0; state.deduped = 0;
  state.items.length = 0; state.lastError = '';
  state.paused = false; state.pauseReason = '';
  failedJobs.length = 0;
  chrome.storage.local.remove([QUEUE_KEY, DONE_KEY, FOLDER_KEY]).catch(() => {});
  // 同步清除浏览器下载历史中本插件产生的记录
  try {
    chrome.downloads.erase({ urlRegex: 'pawchive|^data:' }, () => void chrome.runtime.lastError);
  } catch (e) { /* ignore */ }
  return { ok: true };
}

function getStateSnapshot() {
  const out = JSON.parse(JSON.stringify(state));
  out.failedJobs = failedJobs.slice(-20);
  out.doneCount = doneSet.size;
  return out;
}

/* ---------------- 监控小窗 ---------------- */

let monitorWindowId = null;

async function openMonitor(focus) {
  try {
    if (monitorWindowId !== null) {
      await chrome.windows.get(monitorWindowId);
      if (focus) await chrome.windows.update(monitorWindowId, { focused: true });
      return;
    }
  } catch (e) {
    monitorWindowId = null;
  }
  try {
    const win = await chrome.windows.create({
      url: 'mini/mini.html',
      type: 'popup',
      width: 420,
      height: 600,
      focused: !!focus
    });
    monitorWindowId = win.id;
  } catch (e) { /* ignore */ }
}

chrome.windows.onRemoved.addListener((wid) => {
  if (wid === monitorWindowId) monitorWindowId = null;
});

/* ---------------- 消息入口 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (sender && sender.tab && (msg.type === 'pawchivePost' || msg.type === 'pawchiveCrawlProgress')) {
    crawlTabId = sender.tab.id;   // 记录爬取所在标签页（停止类操作可一并取消爬取）
  }
  if (msg.type === 'pawchiveEnqueue' || msg.type === 'pawchivePost') {
    if (msg.options) {
      lastOptions = msg.options;
      chrome.storage.local.set({ [OPTS_KEY]: msg.options }).catch(() => {});
    }
    sendResponse(enqueuePost(msg.payload, msg.options || lastOptions));
    return;
  }
  if (msg.type === 'pawchivePauseQueue') { sendResponse(doPauseQueue()); return; }
  if (msg.type === 'pwDownloadBlobUrl') {
    // offscreen 创建的 blob URL：由后台下载，命名统一走 onDeterminingFilename
    downloadLocal(msg.url, msg.filename).then((r) => sendResponse(r));
    return true;
  }
  if (msg.type === 'pawchiveResumeQueue') { sendResponse(doResumeQueue()); return; }
  if (msg.type === 'pawchiveStopQueue') { sendResponse(doStopQueue()); return; }
  if (msg.type === 'pawchiveResetRecords') { sendResponse(doResetRecords()); return; }
  if (msg.type === 'pawchiveGetState') { sendResponse(getStateSnapshot()); return; }
  if (msg.type === 'pawchiveOpenMonitor') {
    openMonitor(true).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// 供测试 / 调试（SW isolated world，不泄漏给页面）
globalThis.__pawchiveBg = {
  enqueue: enqueuePost,
  pause: doPauseQueue,
  resume: doResumeQueue,
  stop: doStopQueue,
  reset: doResetRecords,
  getState: getStateSnapshot,
  openMonitor
};
