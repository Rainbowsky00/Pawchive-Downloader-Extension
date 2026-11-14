/** Pawchive Downloader - popup 逻辑 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    pageKind: $('pageKind'),
    errorBox: $('errorBox'),
    postBox: $('postBox'), cardsBox: $('cardsBox'), optBox: $('optBox'), actionBox: $('actionBox'),
    pAuthor: $('pAuthor'), pTitle: $('pTitle'), pDate: $('pDate'), pCounts: $('pCounts'),
    cUrl: $('cUrl'), cCount: $('cCount'), cDelay: $('cDelay'), cLimit: $('cLimit'),
    cFrom: $('cFrom'), cTo: $('cTo'),
    btnCrawl: $('btnCrawl'), btnCrawlCancel: $('btnCrawlCancel'), crawlProgress: $('crawlProgress'),
    optRename: $('optRename'), optRoot: $('optRoot'), pathPreview: $('pathPreview'),
    btnDownload: $('btnDownload'), postResult: $('postResult'),
    dlBox: $('dlBox'), dlSummary: $('dlSummary'), dlItems: $('dlItems'),
    dlPaused: $('dlPaused'), dlPausedText: $('dlPausedText'), btnResume: $('btnResume'),
    btnMonitor: $('btnMonitor'), btnMonitor2: $('btnMonitor2'), btnPauseDl: $('btnPauseDl'), btnStopDl: $('btnStopDl'),
    dlActive: $('dlActive'), dirText: $('dirText'), dirText2: $('dirText2'), verText: $('verText')
  };

  function show(el, on) { el.classList.toggle('hidden', !on); }

  // DOM 完整性自检：浏览器对未打包扩展的 HTML 有缓存，扩展更新后 HTML 可能仍是旧版。
  // 检测到不一致时给出明确的修复指引，而不是静默失效。
  const REQUIRED_IDS = ['pageKind', 'errorBox', 'optRename', 'optRoot', 'cFrom', 'cTo',
    'btnCrawl', 'btnDownload', 'dlBox', 'btnResume', 'dirText', 'verText'];
  const missingEls = REQUIRED_IDS.filter((id) => !document.getElementById(id));
  if (missingEls.length) {
    document.title = '⚠ Pawchive Downloader needs a full browser restart';
    els.pageKind.textContent = '⚠ Extension page is outdated';
    els.errorBox.textContent = 'Old cached extension page detected (missing elements: ' + missingEls.join(', ') + '). '
    els.errorBox.textContent += 'Fix: fully quit Edge/Chrome (close all windows; if "continue running background apps" is enabled, end the background process first), reopen the browser, then click "Reload" on the extensions page.';
    show(els.errorBox, true);
    show(els.errorBox, true);
    return;   // 不再初始化，避免半新半旧引发更多错误
  }

  let scan = null;      // 内容脚本扫描结果
  let tabId = null;
  let crawlActive = false;
  let receivedPosts = 0;

  const DEFAULT_OPTIONS = { rename: true, root: '', delay: 800, scope: 'all', limit: 0, dateFrom: '', dateTo: '' };

  function getOptions() {
    return {
      rename: els.optRename.checked,
      root: els.optRoot.value.trim(),
      delay: Math.max(0, parseInt(els.cDelay.value, 10) || 0),
      scope: (document.querySelector('input[name="scope"]:checked') || {}).value || 'all',
      limit: Math.max(0, parseInt(els.cLimit.value, 10) || 0),
      dateFrom: els.cFrom.value || '',
      dateTo: els.cTo.value || ''
    };
  }

  function saveOptions() {
    chrome.storage.local.set({ options: getOptions() });
    updatePathPreview();
  }

  async function loadOptions() {
    const { options } = await chrome.storage.local.get('options');
    const o = Object.assign({}, DEFAULT_OPTIONS, options || {});
    els.optRename.checked = !!o.rename;
    els.optRoot.value = o.root || '';
    els.cDelay.value = o.delay;
    els.cLimit.value = o.limit;
    els.cFrom.value = o.dateFrom || '';
    els.cTo.value = o.dateTo || '';
    const radio = document.querySelector(`input[name="scope"][value="${o.scope}"]`);
    if (radio) radio.checked = true;
    updatePathPreview();
  }

  function sanitizePreview(s) {
    return (s || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function updatePathPreview() {
    if (!scan || scan.kind !== 'post') { els.pathPreview.textContent = 'Author/YYYY-MM-DD-Title/'; return; }
    const p = scan.payload;
    const root = els.optRoot.value.trim();
    const author = sanitizePreview(p.author) || 'unknown-author';
    const title = sanitizePreview((p.title || '').replace(EMOJI, '')) || `post-${p.postId}`;
    const sub = p.date ? `${p.date}-${title}` : title;
    els.pathPreview.textContent = [root, author, sub].filter(Boolean).join('/') + '/';
  }

  const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

  function showError(msg) {
    els.pageKind.textContent = 'Unavailable';
    els.errorBox.textContent = msg;
    show(els.errorBox, true);
  }

  function tag(text, cls) {
    const s = document.createElement('span');
    s.className = 'tag' + (cls ? ' ' + cls : '');
    s.textContent = text;
    return s;
  }

  /* ---------------- 渲染扫描结果 ---------------- */

  function renderScan() {
    show(els.optBox, true);
    if (scan.kind === 'post') {
      const p = scan.payload;
      els.pageKind.textContent = 'Post page';
      els.pAuthor.textContent = p.author || '(unknown)';
      els.pTitle.textContent = p.title || '(untitled)';
      els.pDate.textContent = p.date || '(unknown)';
      els.pCounts.replaceChildren(
        tag(`Images ${p.images.length}`),
        tag(`Videos ${p.videos.length}`),
        tag(`Cloud links ${(p.links.drive || []).length}`),
        tag(`Video links ${(p.links.video || []).length}`),
        tag(`Attachments ${(p.links.attach || []).length + (p.attach || []).length}`)
      );
      show(els.postBox, true);
      show(els.actionBox, true);
    } else if (scan.kind === 'cards') {
      els.pageKind.textContent = 'List page (author / search results)';
      els.cUrl.textContent = scan.authorId || scan.url;
      els.cCount.textContent = `${scan.cards.length} posts on this page` + (scan.maxOffset > 0 ? `, paginated to o=${scan.maxOffset}` : '');
      show(els.cardsBox, true);
    } else {
      els.pageKind.textContent = 'Unsupported page';
      showError('This page is neither a post page nor a post list. Open a Pawchive post or author page and try again.');
    }
    updatePathPreview();
  }

  /* ---------------- 下载状态轮询 ---------------- */

  let lastItemsJson = '';

  function renderDlState(st) {
    if (st.items.length === 0 && !st.running && !st.paused) { show(els.dlBox, false); return; }
    show(els.dlBox, true);
    // 在途任务（正在下载）
    const act = st.active || [];
    if (act.length) {
      if (els.dlActive) els.dlActive.textContent = 'Downloading: ' + act.map((a) => {
        const pct = a.total > 0 ? ` (${Math.min(100, Math.round((a.received / a.total) * 100))}%)` : '';
        return a.filename.split('/').pop() + pct;
      }).join('、');
      if (els.dlActive) show(els.dlActive, true);
    } else {
      if (els.dlActive) show(els.dlActive, false);
    }
    if (els.btnPauseDl) els.btnPauseDl.disabled = !!st.paused;
    // 暂停提示（站点限流时自动触发）
    if (st.paused) {
      show(els.dlPaused, true);
      if (els.dlPausedText) els.dlPausedText.textContent = `Paused: ${st.pauseReason || 'manual pause'}.` +
        `\n${st.queued} remaining tasks are saved. Click "Resume" to continue.`;
    } else {
      show(els.dlPaused, false);
    }
    els.dlSummary.textContent = `Queued ${st.queued} · Sent ${st.sent} · Done ${st.completed}` +
      (st.failed || st.interrupted ? ` · Failed ${st.failed + st.interrupted}` : '') +
      (st.retried ? ` · Retried ${st.retried}` : '') +
      (st.throttled ? ` · Throttled ${st.throttled}` : '') +
      (st.namingConflict ? ' · ⚠ Filenames overridden by another extension (disable it in Edge, or remove and re-add this extension)' : '');
    const recent = st.items.slice(-40).reverse();
    // 按文件聚合（同一文件只显示最新状态，避免刷屏重复）
    const agg = new Map();
    st.items.forEach((it, idx) => agg.set(it.filename, { status: it.status, idx }));
    const uniq = [...agg.entries()].slice(-40).reverse();
    const json = JSON.stringify(uniq.map(([f, i]) => [f, i.status]));
    if (json === lastItemsJson) return;   // 内容没变就不重建 DOM
    lastItemsJson = json;
    els.dlItems.replaceChildren(...uniq.map(([filename, info]) => {
      const div = document.createElement('div');
      div.className = 'item';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = filename;
      const st2 = document.createElement('span');
      st2.className = 'st-' + info.status;
      const map = { sending: 'sending', downloading: 'downloading', done: '✓', failed: '✗', interrupted: 'interrupted', retry: '↻ retry' };
      st2.textContent = map[info.status] || info.status;
      div.append(name, st2);
      return div;
    }));
  }

  setInterval(async () => {
    try {
      const st = await chrome.runtime.sendMessage({ type: 'pawchiveGetState' });
      if (st) renderDlState(st);
    } catch (e) { /* ignore */ }
  }, 500);

  /* ---------------- 事件 ---------------- */

  els.optRename.addEventListener('change', saveOptions);
  els.optRoot.addEventListener('input', saveOptions);
  els.cDelay.addEventListener('change', saveOptions);
  els.cLimit.addEventListener('change', saveOptions);
  els.cFrom.addEventListener('change', saveOptions);
  els.cTo.addEventListener('change', saveOptions);
  document.querySelectorAll('input[name="scope"]').forEach((r) => r.addEventListener('change', saveOptions));

  const openMonitorWin = async () => {
    try { await chrome.runtime.sendMessage({ type: 'pawchiveOpenMonitor' }); } catch (e) { /* ignore */ }
    window.close();
  };
  els.btnMonitor.addEventListener('click', openMonitorWin);
  els.btnMonitor2.addEventListener('click', openMonitorWin);

  els.btnDownload.addEventListener('click', async () => {
    if (!scan || scan.kind !== 'post') return;
    els.btnDownload.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'pawchiveEnqueue',
        payload: scan.payload,
        options: getOptions()
      });
      show(els.postResult, true);
      if (res && res.ok) {
        els.postResult.textContent = `Queued: ${res.images} images, ${res.videos} videos\r\nFolder: ${res.folder}/`;
      } else {
        els.postResult.textContent = 'Failed to queue: ' + ((res && res.error) || 'unknown error');
      }
    } catch (e) {
      show(els.postResult, true);
      els.postResult.textContent = 'Error: ' + e.message;
    } finally {
      els.btnDownload.disabled = false;
    }
  });

  els.btnCrawl.addEventListener('click', async () => {
    if (!scan || scan.kind !== 'cards') return;
    const options = getOptions();
    try {
      const res = await chrome.tabs.sendMessage(tabId, {
        type: 'pawchiveCrawl',
        scope: options.scope,
        delay: options.delay,
        limit: options.limit,
        dateFrom: options.dateFrom,
        dateTo: options.dateTo,
        maxOffset: scan.maxOffset || 0,
        options: { rename: options.rename, root: options.root }
      });
      if (res && res.started) {
        crawlActive = true;
        receivedPosts = 0;
        show(els.btnCrawlCancel, true);
        els.btnCrawl.disabled = true;
        show(els.crawlProgress, true);
        els.crawlProgress.textContent = 'Collecting post links…\r\n(Tip: you can close this popup; downloads continue in the background)';
      } else {
        show(els.crawlProgress, true);
        els.crawlProgress.textContent = (res && res.message) || 'Failed to start';
      }
    } catch (e) {
      show(els.crawlProgress, true);
      els.crawlProgress.textContent = 'Failed to start: ' + e.message;
    }
  });

  els.btnCrawlCancel.addEventListener('click', async () => {
    try { await chrome.tabs.sendMessage(tabId, { type: 'pawchiveCrawlCancel' }); } catch (e) { /* ignore */ }
    els.btnCrawlCancel.disabled = true;
  });

  els.btnResume.addEventListener('click', async () => {
    els.btnResume.disabled = true;
    try { await chrome.runtime.sendMessage({ type: 'pawchiveResumeQueue' }); } catch (e) { /* ignore */ }
    els.btnResume.disabled = false;
    show(els.dlPaused, false);
  });


  // 保存位置显示：从最近下载记录推导Browser download folder（不触发任何下载，避免留下探针文件）
  async function probeDownloadsPath() {
    const { downloadsPath, downloadsPathAt } = await chrome.storage.local.get(['downloadsPath', 'downloadsPathAt']);
    const fresh = downloadsPath && downloadsPathAt && (Date.now() - downloadsPathAt < 7 * 24 * 3600e3);
    if (fresh) return downloadsPath;
    try {
      const items = await new Promise((res) => chrome.downloads.search(
        { limit: 5, orderBy: ['-startTime'], state: 'complete' },
        (arr) => res(arr || [])
      ));
      for (const it of items) {
        const fn = it.filename || '';
        const i = Math.max(fn.lastIndexOf('\\'), fn.lastIndexOf('/'));
        if (i > 0) {
          const dir = fn.slice(0, i);
          await chrome.storage.local.set({ downloadsPath: dir, downloadsPathAt: Date.now() });
          return dir;
        }
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  async function renderDir() {
    if (!els.dirText || !els.dirText2) return;   // 旧缓存页面：跳过
    const abs = await probeDownloadsPath();
    const txt = 'Browser download folder' + (abs ? '\n' + abs : '\n(path unavailable; downloads are unaffected)');
    if (els.dirText) els.dirText.textContent = txt;
    if (els.dirText2) els.dirText2.textContent = txt;
  }
  renderDir();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.downloadsPath) renderDir();
  });

  els.btnPauseDl.addEventListener('click', async () => {
    els.btnPauseDl.disabled = true;
    try { await chrome.runtime.sendMessage({ type: 'pawchivePauseQueue' }); } catch (e) { /* ignore */ }
    els.btnPauseDl.disabled = false;
  });

  els.btnStopDl.addEventListener('click', async () => {
    els.btnStopDl.disabled = true;
    try { await chrome.runtime.sendMessage({ type: 'pawchiveStopQueue' }); } catch (e) { /* ignore */ }
    els.btnStopDl.disabled = false;
    show(els.dlPaused, false);
  });

  /* ---------------- 爬取进度消息 ---------------- */

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'pawchiveCrawlProgress') {
      if (!crawlActive) { crawlActive = true; show(els.crawlProgress, true); show(els.btnCrawlCancel, true); }
      const line = formatCrawlLine(msg);
      if (line) {
        els.crawlProgress.textContent = (els.crawlProgress.textContent + '\r\n' + line)
          .split('\r\n').slice(-60).join('\r\n');
        els.crawlProgress.scrollTop = els.crawlProgress.scrollHeight;
      }
      if (msg.phase === 'done') {
        crawlActive = false;
        els.btnCrawl.disabled = false;
        els.btnCrawlCancel.disabled = false;
        show(els.btnCrawlCancel, false);
      }
    }
    if (msg.type === 'pawchivePost') receivedPosts++;
  });

  function formatCrawlLine(msg) {
    switch (msg.phase) {
      case 'list': return `[list] page ${msg.page}/${msg.pages}: ${msg.url}`;
      case 'listExtend': return `[list] extending beyond paginator: page ${msg.page}`;
      case 'listError': return `[list] fetch failed: ${msg.url} (${msg.message})`;
      case 'earlyStop': return `[early stop] page ${msg.page} and later are older than the start date; stopped paging`;
      case 'post': return `[post] ${msg.index}/${msg.total}: ${msg.url}`;
      case 'skip': return `[skip] ${msg.date || 'no date'} outside date range: ${msg.url}`;
      case 'postError': return `[post] failed: ${msg.url} (${msg.message})`;
      case 'done': {
        const parts = [`[done] ${msg.posts} posts succeeded`];
        if (msg.skipped) parts.push(`skipped ${msg.skipped}`);
        if (msg.failed) parts.push(`failed ${msg.failed}`);
        if (msg.cancelled) parts.push('(stopped manually)');
        return parts.join('，');
      }
      default: return '';
    }
  }

  /* ---------------- 启动 ---------------- */

  if (els.verText) els.verText.textContent = 'v' + chrome.runtime.getManifest().version;

  (async () => {
    try {
      await loadOptions();
    } catch (e) { /* 选项读取失败使用默认值 */ }
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return showError('No active tab found');
      tabId = tab.id;
      scan = await chrome.tabs.sendMessage(tabId, { type: 'pawchiveScan' });
      renderScan();
    } catch (e) {
      showError('This extension only works on pawchive.pw. Open a Pawchive post or author page first, then click the extension icon.');
    }
  })();
})();
