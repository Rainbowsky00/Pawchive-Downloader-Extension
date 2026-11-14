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
    document.title = '⚠ Pawchive 插件需要彻底重启浏览器';
    els.pageKind.textContent = '⚠ 插件页面版本不完整';
    els.errorBox.textContent = '检测到旧版页面缓存（缺少元素: ' + missingEls.join(', ') + '）。'
    els.errorBox.textContent += '修复方法：完全退出 Edge/Chrome（关闭所有窗口；若开启了"后台运行"请先结束后台进程），重新打开浏览器，再在扩展管理页点击「重新加载」。'
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
    if (!scan || scan.kind !== 'post') { els.pathPreview.textContent = '作者/年-月-日-标题/'; return; }
    const p = scan.payload;
    const root = els.optRoot.value.trim();
    const author = sanitizePreview(p.author) || 'unknown-author';
    const title = sanitizePreview((p.title || '').replace(EMOJI, '')) || `post-${p.postId}`;
    const sub = p.date ? `${p.date}-${title}` : title;
    els.pathPreview.textContent = [root, author, sub].filter(Boolean).join('/') + '/';
  }

  const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

  function showError(msg) {
    els.pageKind.textContent = '无法使用';
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
      els.pageKind.textContent = '帖子详情页';
      els.pAuthor.textContent = p.author || '(未知)';
      els.pTitle.textContent = p.title || '(无标题)';
      els.pDate.textContent = p.date || '(未知)';
      els.pCounts.replaceChildren(
        tag(`原图 ${p.images.length}`),
        tag(`视频 ${p.videos.length}`),
        tag(`云盘链接 ${(p.links.drive || []).length}`),
        tag(`视频链接 ${(p.links.video || []).length}`),
        tag(`附件 ${(p.links.attach || []).length + (p.attach || []).length}`)
      );
      show(els.postBox, true);
      show(els.actionBox, true);
    } else if (scan.kind === 'cards') {
      els.pageKind.textContent = '列表页（作者 / 搜索结果）';
      els.cUrl.textContent = scan.authorId || scan.url;
      els.cCount.textContent = `本页 ${scan.cards.length} 个帖子` + (scan.maxOffset > 0 ? `，分页到 o=${scan.maxOffset}` : '');
      show(els.cardsBox, true);
    } else {
      els.pageKind.textContent = '不支持的页面';
      showError('当前页面既不是帖子详情页，也没有帖子列表。请打开 Pawchive 的帖子或作者页面后重试。');
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
      if (els.dlActive) els.dlActive.textContent = '正在下载：' + act.map((a) => {
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
      if (els.dlPausedText) els.dlPausedText.textContent = `已暂停：${st.pauseReason || '手动暂停'}。` +
        `\n剩余 ${st.queued} 个任务已保存，处理完后点「继续下载」即可续传。`;
    } else {
      show(els.dlPaused, false);
    }
    els.dlSummary.textContent = `队列 ${st.queued} · 已发送 ${st.sent} · 完成 ${st.completed}` +
      (st.failed || st.interrupted ? ` · 失败 ${st.failed + st.interrupted}` : '') +
      (st.retried ? ` · 重试 ${st.retried}` : '') +
      (st.throttled ? ` · 限速降档 ${st.throttled}` : '') +
      (st.namingConflict ? ' · ⚠ 文件名被其他扩展改写（Edge 下停用其他下载扩展，或移除并重载本插件）' : '');
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
      const map = { sending: '发送中', downloading: '下载中', done: '✓', failed: '✗', interrupted: '中断', retry: '↻ 重试' };
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
        els.postResult.textContent = `已加入下载队列：图片 ${res.images} 个、视频 ${res.videos} 个\r\n目录：${res.folder}/`;
      } else {
        els.postResult.textContent = '加入队列失败：' + ((res && res.error) || '未知错误');
      }
    } catch (e) {
      show(els.postResult, true);
      els.postResult.textContent = '出错：' + e.message;
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
        els.crawlProgress.textContent = '开始收集帖子链接…\r\n（提示：爬取过程中可以关闭弹窗，下载会在后台继续）';
      } else {
        show(els.crawlProgress, true);
        els.crawlProgress.textContent = (res && res.message) || '启动失败';
      }
    } catch (e) {
      show(els.crawlProgress, true);
      els.crawlProgress.textContent = '启动失败：' + e.message;
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


  // 保存位置显示：从最近下载记录推导浏览器下载目录（不触发任何下载，避免留下探针文件）
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
    const txt = '浏览器下载目录' + (abs ? '\n' + abs : '\n（暂无法获取路径，不影响下载）');
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
      case 'list': return `[列表] 第 ${msg.page}/${msg.pages} 页：${msg.url}`;
      case 'listExtend': return `[列表] 分页器之外继续追加第 ${msg.page} 页`;
      case 'listError': return `[列表] 抓取失败：${msg.url} (${msg.message})`;
      case 'earlyStop': return `[提前停止] 第 ${msg.page} 页起全部早于起始日期，停止翻页`;
      case 'post': return `[帖子] ${msg.index}/${msg.total}：${msg.url}`;
      case 'skip': return `[跳过] ${msg.date || '无日期'} 不在时间范围：${msg.url}`;
      case 'postError': return `[帖子] 失败：${msg.url} (${msg.message})`;
      case 'done': {
        const parts = [`[完成] 成功 ${msg.posts} 帖`];
        if (msg.skipped) parts.push(`跳过 ${msg.skipped}`);
        if (msg.failed) parts.push(`失败 ${msg.failed}`);
        if (msg.cancelled) parts.push('（已手动停止）');
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
      if (!tab || !tab.id) return showError('找不到当前标签页');
      tabId = tab.id;
      scan = await chrome.tabs.sendMessage(tabId, { type: 'pawchiveScan' });
      renderScan();
    } catch (e) {
      showError('本插件只支持 pawchive.pw 站点。请先打开 Pawchive 的帖子页面或作者页面，再点击插件图标。');
    }
  })();
})();
