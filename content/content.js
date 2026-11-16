/**
 * Pawchive Downloader - content script
 * 负责：解析当前帖子页（作者/标题/日期/原图/视频/正文链接），以及批量爬取作者页的全部帖子。
 * 只收集 a.fileThumb 的 href（原图），跳过 lazy 加载的 img 缩略图（img.pawchive.pw/thumbnail）。
 */
(() => {
  'use strict';

  /* ---------------- 基础工具 ---------------- */

  const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov|mkv|avi|wmv|flv|mpg|mpeg|mpe|ts|3gp|ogv|m2ts|vob)$/i;
  const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|ico|tiff?|apng|jfif|avif|heic|heif|svg)$/i;

  // 明确的网盘 / 文件中转站关键词（匹配 host + path）
  const DRIVE_STRONG = [
    'dropbox', 'googledrive', 'drive.google', 'docs.google', 'mega.nz', 'mega.io',
    'terabox', '1drv', 'onedrive', 'sharepoint', 'pikpak', 'synology', 'quickconnect',
    'pcloud', 'mediafire', 'gofile', 'pixeldrain', 'wetransfer', 'we.tl', 'zippyshare',
    'sendspace', '4shared', 'megaup', 'krakenfiles', 'box.com', 'mirrobox', 'nephobox',
    'momerybox', 'tibibox', 'freeterabox', '1024tera', 'teraboxapp', 'bunkr', 'cyberdrop',
    'erome', 'catbox', 'litterbox', 'hitfile', 'nitroflare', 'rapidgator', 'turbobit',
    'fembed', 'streamtape', 'dood.', 'apkadmin', 'modsbase'
  ];
  // 泛化关键词：只要 host 里带这些词就"可能是网盘"（按需求宽松收录）
  const DRIVE_GENERIC = ['drive', 'pan.', 'disk', 'cloud', 'storage', 'nas', 'mega', 'sync', 'transfer', 'upload', 'file.'];
  // 泛化匹配时排除的常见社交/非网站 host
  const SOCIAL_EXCLUDE = [
    'google.com', 'youtube', 'youtu.be', 'twitter.com', 'x.com', 't.me', 'telegram',
    'discord', 'reddit', 'patreon', 'fanbox', 'pixiv', 'fantia', 'github', 'gitlab',
    'linktr.ee', 'ko-fi', 'gumroad', 'boosty', 'subscribestar', 'onlyfans', 'instagram',
    'facebook', 'vk.com', 'theporndude', 'furaffinity', 'inkbunny', 'deviantart',
    'artstation', 'toyhou.se', 'bluesky', 'bsky.app', 'twitch', 'picarto', 'streamlabs'
  ];

  function absUrl(href, base) {
    if (!href) return '';
    try { return new URL(href, base).href; } catch (e) { return ''; }
  }

  function isVideoUrl(u) { return VIDEO_EXT_RE.test(urlPathname(u)); }
  function isImageUrl(u) { return IMG_EXT_RE.test(urlPathname(u)); }

  function urlPathname(u) {
    try { return new URL(u).pathname; } catch (e) { return u || ''; }
  }

  function urlFilename(u) {
    try {
      const url = new URL(u);
      // kemono 风格：?f= 带原始文件名
      const f = url.searchParams.get('f');
      if (f) return f;
      const p = url.pathname.split('/').filter(Boolean);
      return p.length ? decodeURIComponent(p[p.length - 1]) : '';
    } catch (e) { return ''; }
  }

  function urlExt(u, fallback) {
    const m = /\.([a-z0-9]+)$/i.exec(urlPathname(u).split('/').pop() || '');
    if (m) return m[1].toLowerCase();
    const name = urlFilename(u);
    const m2 = /\.([a-z0-9]{1,5})$/i.exec(name || '');
    return m2 ? m2[1].toLowerCase() : (fallback || 'jpg');
  }

  function classifyLink(u) {
    let host = '', path = '';
    try {
      const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    host = url.hostname.toLowerCase();
    path = (url.pathname + url.search).toLowerCase();
  } catch (e) { return null; }
  // 站内数据服务器的视频直链也是有效视频链接（先于站点排除判断）
  if (isVideoUrl(u)) return 'video';
  if (host === 'pawchive.pw' || host.endsWith('.pawchive.pw')) return null;
    const hay = host + path;
    if (DRIVE_STRONG.some((k) => hay.includes(k))) return 'drive';
    const isSocial = SOCIAL_EXCLUDE.some((k) => host.includes(k));
    if (!isSocial && DRIVE_GENERIC.some((k) => host.includes(k))) return 'drive';
    return null;
  }

  /* ---------------- 帖子解析 ---------------- */

  function pickTitle(section) {
    const h1 = section.querySelector('.post__title');
    if (!h1) return '';
    const spans = Array.from(h1.querySelectorAll('span')).map((s) => s.textContent.trim()).filter(Boolean);
    // 跳过 "(Patreon)" 这类平台后缀
    const real = spans.find((t) => !/^\(.+\)$/.test(t));
    return real || h1.textContent.trim() || '';
  }

  function normalizeDate(text) {
    if (!text) return '';
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  }

  // 从一段富文本容器里抽取链接（<a href> + 文本中的裸链接），分类
  function extractLinks(container, pageUrl) {
    const out = { drive: [], video: [], attach: [] };
    if (!container) return out;
    const seen = new Set();
    const push = (rawUrl, label) => {
      const u = rawUrl.replace(/[)\]}>,.;!'"]+$/, '');
      if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) return;
      seen.add(u);
      const kind = classifyLink(u);
      if (kind === 'drive') out.drive.push(u);
      else if (kind === 'video') out.video.push({ url: u, filename: urlFilename(u) });
      else if (kind === null && label && /\.(zip|rar|7z|pdf|psd|clip|cba|cbz)$/i.test(urlPathname(u))) {
        out.attach.push({ url: u, filename: urlFilename(u) });
      }
    };
    container.querySelectorAll('a[href]').forEach((a) => push(absUrl(a.getAttribute('href'), pageUrl)));
    // 文本里的裸链接
    const text = container.textContent || '';
    const re = /https?:\/\/[^\s<>"'（）【】]+/gi;
    let m;
    while ((m = re.exec(text)) !== null) push(m[0]);
    // 内嵌 <video>
    container.querySelectorAll('video').forEach((v) => {
      const src = v.currentSrc || v.src || (v.querySelector('source') && v.querySelector('source').src);
      if (src && /^https?:/i.test(src) && !seen.has(src)) {
        seen.add(src);
        out.video.push({ url: src, filename: urlFilename(src) });
      }
    });
    return out;
  }

  function parsePost(doc, pageUrl) {
    const section = doc.querySelector('section#page.site-section--post') || doc.querySelector('section.site-section--post#page');
    if (!section) return null;

    const author = ((section.querySelector('.post__user-name') || {}).textContent || '').trim()
      || (doc.querySelector('meta[name="artist_name"]') || {}).content || '';

    const title = pickTitle(section);

    const published = (doc.querySelector('meta[name="published"]') || {}).content
      || ((section.querySelector('.post__published') || {}).textContent || '');
    const date = normalizeDate(published);

    // Files 区：a.fileThumb 的 href 即原图/视频原文件（部分服务可能没有 .post__files 容器，兜底全局找）
    const images = [];
    const videos = [];
    const media = [];          // 按页面出现顺序的媒体（图片+视频混排），重命名时统一编号
    const attach = [];
    const seenFile = new Set();
    let fileScope = section.querySelectorAll('.post__files a.fileThumb');
    if (!fileScope.length) fileScope = section.querySelectorAll('a.fileThumb');
    fileScope.forEach((a) => {
      const url = absUrl(a.getAttribute('href'), pageUrl);
      if (!url || seenFile.has(url)) return;
      seenFile.add(url);
      const name = a.getAttribute('download') || urlFilename(url);
      if (isVideoUrl(url)) {
        const v = { url, filename: name, ext: urlExt(url, 'mp4') };
        videos.push(v);
        media.push({ ...v, kind: 'video' });
      } else if (isImageUrl(url)) {
        const im = { url, filename: name, ext: urlExt(url) };
        images.push(im);
        media.push({ ...im, kind: 'image' });
      } else {
        attach.push({ url, filename: name });
      }
    });

    // 正文里的内嵌原图（排除 img.pawchive.pw/thumbnail 缩略图、/static/ /icons/ /banners/）
    doc.querySelectorAll('.post__content img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (!/^https?:\/\//i.test(src)) return;
      let host = '', path = '';
      try { const u = new URL(src); host = u.hostname; path = u.pathname; } catch (e) { return; }
      if (host.endsWith('pawchive.pw') && (host.startsWith('img.') || /^\/(static|icons|banners)\//.test(path))) return;
      if (seenFile.has(src)) return;
      seenFile.add(src);
      if (isVideoUrl(src)) {
        const v = { url: src, filename: urlFilename(src), ext: urlExt(src, 'mp4') };
        videos.push(v);
        media.push({ ...v, kind: 'video' });
      } else if (isImageUrl(src)) {
        const im = { url: src, filename: urlFilename(src), ext: urlExt(src) };
        images.push(im);
        media.push({ ...im, kind: 'image' });
      }
    });

    const links = extractLinks(section.querySelector('.post__content'), pageUrl);

    return {
      kind: 'post',
      pageUrl,
      service: section.dataset.service || '',
      userId: section.dataset.user || '',
      postId: section.dataset.id || '',
      author,
      title,
      date,
      images,
      videos,
      media,
      attach,
      links
    };
  }

  /* ---------------- 列表页扫描（作者页 / posts 页） ---------------- */

  // 日期是否落在 [from, to] 闭区间内；from/to 为空表示该侧不限制。
  // YYYY-MM-DD 字符串可直接做字典序比较。
  function inDateRange(date, from, to) {
    if (!from && !to) return true;
    if (!date) return false;          // 设了范围但帖子无日期 → 视为不在范围内
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  }

  // 列表阶段按日期过滤帖子卡片（省去抓取范围外帖子的请求）。
  // earlyStop：整页卡片都有日期且全部早于起始日 → 站点是最新在前翻页，可以提前停止。
  function filterCardsByDate(cards, from, to) {
    const kept = [];
    let dated = 0;
    let older = 0;
    for (const c of cards) {
      if (!c.date) { kept.push(c); continue; }   // 无日期的保留，帖子阶段再核对
      dated++;
      if (inDateRange(c.date, from, to)) kept.push(c);
      else if (from && c.date < from) older++;
    }
    const earlyStop = !!(from && dated > 0 && dated === older && kept.length === 0);
    return { kept, earlyStop };
  }


  // 作者标识：渠道-作者ID（如 fanbox-creator）
  // htmx 换页时 <head> 的 meta 可能仍是上一页的值，所以渠道优先取当前 URL，
  // 作者优先取当前可见的用户头部，meta 只作兜底。
  function makeAuthorId(doc, pageUrl) {
    const meta = (name) => {
      const el = doc.querySelector(`meta[name="${name}"]`);
      return el ? (el.getAttribute('content') || '').trim() : '';
    };
    let service = '';
    try { service = new URL(pageUrl).pathname.split('/').filter(Boolean)[0] || ''; } catch (e) { /* ignore */ }
    if (!service) service = meta('service');

    let name = '';
    const header = doc.querySelector('.user-header__name, h1.site-section__heading');
    if (header) {
      const nameEl = header.querySelector('[itemprop="name"]');
      name = ((nameEl || header).textContent || '').trim();
    }
    if (!name) name = meta('artist_name');
    if (!name) name = meta('id');
    const clean = (s) => String(s || '')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '');
    return (clean(service) || 'pawchive') + '-' + (clean(name) || 'unknown');
  }

  function scanPage() {
    const payload = parsePost(document, location.href);
    if (payload) return { kind: 'post', payload };

    const cards = Array.from(document.querySelectorAll('article.post-card')).map((card) => {
      const a = card.querySelector('a[href*="/post/"]');
      const t = card.querySelector('.timestamp');
      return {
        url: a ? absUrl(a.getAttribute('href'), location.href) : '',
        title: ((card.querySelector('.post-card__header') || {}).textContent || '').trim(),
        date: t ? normalizeDate(t.getAttribute('datetime') || t.textContent || '') : '',
        attachments: ((((card.querySelector('.post-card__footer') || {}).textContent || '').match(/(\d+)\s*attachments?/i) || [])[1]) || ''
      };
    }).filter((c) => c.url);

    if (cards.length) {
      // 分页：.paginator 里 ?o=N 的最大偏移
      let maxOffset = 0;
      document.querySelectorAll('.paginator a[href*="o="]').forEach((a) => {
        try {
          const o = parseInt(new URL(absUrl(a.getAttribute('href'), location.href)).searchParams.get('o'), 10);
          if (Number.isFinite(o) && o > maxOffset) maxOffset = o;
        } catch (e) { /* ignore */ }
      });
      return { kind: 'cards', url: location.href, cards, maxOffset, authorId: makeAuthorId(document, location.href) };
    }
    return { kind: 'other', url: location.href };
  }

  /* ---------------- 批量爬取 ---------------- */

  let crawling = false;
  let cancelRequested = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchText(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  // 网络抖动 / 限流时重试（列表页与帖子页共用）
  async function fetchTextRetry(url, tries = 3) {
    for (let k = 1; ; k++) {
      try {
        return await fetchText(url);
      } catch (e) {
        if (k >= tries) throw e;
        sendRuntime({ type: 'pawchiveCrawlProgress', phase: 'retry', url, attempt: k, message: String(e) });
        await sleep(1500 * k);
      }
    }
  }

  function sendRuntime(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => { /* popup 未打开时忽略 */ });
    } catch (e) { /* ignore */ }
  }

  // 给后台发消息并等待响应（用于逐帖下载状态）
  function sendRuntimeAsync(msg) {
    return new Promise((resolve) => {
      try {
        const p = chrome.runtime.sendMessage(msg);
        if (p && typeof p.then === 'function') p.then(resolve).catch(() => resolve(null));
        else resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  function cleanPostUrl(raw, base) {
    try {
      const u = new URL(raw, base || location.href);
      u.search = ''; u.hash = '';
      return u.href;
    } catch (e) { return ''; }
  }

  let listing = false;
  let postsCache = { key: '', posts: [] };

  // 收集列表页里的帖子（只抓列表页，不抓帖子详情）
  async function collectList(opts) {
    const base = new URL(location.href);
    base.hash = '';
    const step = 50;
    const offsets = [0];
    if (opts.scope === 'all') {
      const maxO = Math.max(0, opts.maxOffset || 0);
      for (let o = step; o <= maxO; o += step) offsets.push(o);
    }

    const found = [];
    const seen = new Set();
    let extraPages = 0;
    for (let i = 0; i < offsets.length; i++) {
      if (cancelRequested) break;
      const u = new URL(base);
      if (offsets[i] > 0) u.searchParams.set('o', String(offsets[i]));
      else u.searchParams.delete('o');
      sendRuntime({ type: 'pawchiveCrawlProgress', phase: 'list', page: i + 1, pages: offsets.length, url: u.href });
      try {
        const html = await fetchTextRetry(u.href);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const cards = [];
        doc.querySelectorAll('article.post-card').forEach((card) => {
          const a = card.querySelector('a[href*="/post/"]');
          if (!a) return;
          const url = cleanPostUrl(a.getAttribute('href'), u.href);
          if (!url) return;
          const t = card.querySelector('.timestamp');
          const header = card.querySelector('.post-card__header');
          const footer = card.querySelector('.post-card__footer');
          cards.push({
            url,
            title: ((header && header.textContent) || '').trim(),
            date: normalizeDate((t && (t.getAttribute('datetime') || t.textContent)) || ''),
            attachments: ((((footer && footer.textContent) || '').match(/(\d+)\s*attachments?/i) || [])[1]) || ''
          });
        });
        let addedNew = 0;
        for (const c of cards) {
          if (!seen.has(c.url)) { seen.add(c.url); found.push(c); addedNew++; }
        }
        // 计划分页用尽但最后一页仍有新帖子 → 追加下一页
        if (i === offsets.length - 1 && opts.scope === 'all' && cards.length > 0 && addedNew > 0
            && !cancelRequested && extraPages < 200) {
          offsets.push(offsets[i] + 50);
          extraPages++;
          sendRuntime({ type: 'pawchiveCrawlProgress', phase: 'listExtend', page: offsets.length, url: u.href });
        }
      } catch (e) {
        sendRuntime({ type: 'pawchiveCrawlProgress', phase: 'listError', url: u.href, message: String(e) });
      }
      if (i < offsets.length - 1 && !cancelRequested) await sleep(opts.delay);
    }
    return found;
  }

  // 只加载帖子列表（供弹窗勾选），结果缓存在标签页内
  async function listPosts(opts) {
    if (listing || crawling) return { ok: false, message: 'A task is already running' };
    listing = true;
    cancelRequested = false;
    try {
      const posts = await collectList(opts);
      postsCache = { key: location.href, posts };
      sendRuntime({ type: 'pawchiveCrawlProgress', phase: 'listed', count: posts.length });
      return { ok: true, posts };
    } finally {
      listing = false;
    }
  }

  // 等后台把这一帖的任务全部结案（完成/失败/丢弃），再抓下一帖
  async function waitPostDone(postKey, index, total) {
    const deadline = Date.now() + 30 * 60e3;
    while (!cancelRequested && Date.now() < deadline) {
      const st = await sendRuntimeAsync({ type: 'pawchivePostStatus', postKey });
      if (!st || st.unknown || st.pending <= 0) return;
      sendRuntime({
        type: 'pawchiveCrawlProgress', phase: 'postWait',
        index, total, pending: st.pending, done: st.done, failed: st.failed, postTotal: st.total
      });
      await sleep(1000);
    }
  }

  async function crawl(opts) {
    if (crawling || listing) return { started: false, message: (globalThis.PawLang ? PawLang.pick('已有任务在进行中', 'A task is already running') : 'A task is already running') };
    crawling = true;
    cancelRequested = false;
    (async () => {
      try {
        const explicit = Array.isArray(opts.urls) && opts.urls.length > 0;
        let urls;
        if (explicit) {
          // 弹窗里勾选的帖子：直接用这些 URL，不再收集列表
          const seen = new Set();
          urls = [];
          for (const raw of opts.urls) {
            const u = cleanPostUrl(raw, location.href);
            if (u && !seen.has(u)) { seen.add(u); urls.push({ url: u }); }
          }
        } else {
          const found = await collectList(opts);
          urls = found;
        }
        if (opts.limit > 0 && urls.length > opts.limit) urls = urls.slice(0, opts.limit);

        // 逐帖：抓取 → 解析 → 入队 → 等这一帖下载完 → 下一帖
        let done = 0;
        let failed = 0;
        let skipped = 0;
        for (const item of urls) {
          if (cancelRequested) break;
          const index = done + failed + skipped + 1;
          sendRuntime({ type: 'pawchiveCrawlProgress', phase: 'post', index, total: urls.length, url: item.url });
          try {
            const html = await fetchTextRetry(item.url);
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const payload = parsePost(doc, item.url);
            if (!payload) {
              skipped++;
              sendRuntime({ type: 'pawchiveCrawlProgress', phase: 'skip', url: item.url, reason: (globalThis.PawLang ? PawLang.pick('解析失败（非帖子页）', 'parse failed (not a post page)') : 'parse failed (not a post page)') });
            } else if (!explicit && !inDateRange(payload.date, opts.dateFrom, opts.dateTo)) {
              skipped++;
              sendRuntime({ type: 'pawchiveCrawlProgress', phase: 'skip', url: item.url, date: payload.date });
            } else {
              const res = await sendRuntimeAsync({ type: 'pawchivePost', payload, options: opts.options });
              if (!res || !res.ok) {
                failed++;
                sendRuntime({ type: 'pawchiveCrawlProgress', phase: 'postError', url: item.url, message: (res && res.error) || 'enqueue failed' });
              } else {
                if (res.jobs > 0 && res.postKey) {
                  sendRuntime({ type: 'pawchiveCrawlProgress', phase: 'postQueued', index, total: urls.length, jobs: res.jobs, folder: res.folder });
                  await waitPostDone(res.postKey, index, urls.length);
                }
                done++;
              }
            }
          } catch (e) {
            failed++;
            sendRuntime({ type: 'pawchiveCrawlProgress', phase: 'postError', url: item.url, message: String(e) });
          }
          if (!cancelRequested) await sleep(opts.delay);
        }
        sendRuntime({ type: 'pawchiveCrawlProgress', phase: 'done', posts: done, failed, skipped, cancelled: cancelRequested });
      } finally {
        crawling = false;
      }
    })();
    return { started: true };
  }

  /* ---------------- 消息入口 ---------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'pawchiveScan') {
      sendResponse(scanPage());
      return;
    }
    if (msg.type === 'pawchiveCrawl') {
      crawl(msg).then(sendResponse);
      return true;
    }
    if (msg.type === 'pawchiveListPosts') {
      listPosts(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, message: String(e) }));
      return true;
    }
    if (msg.type === 'pawchiveGetPosts') {
      const same = postsCache.key === location.href;
      sendResponse({ ok: true, cached: same && postsCache.posts.length > 0, posts: same ? postsCache.posts : [] });
      return;
    }
    if (msg.type === 'pawchiveCrawlCancel') {
      cancelRequested = true;
      sendResponse({ ok: true });
      return;
    }
  });

  // 供调试 / 测试使用（content script 运行在 isolated world，不会泄漏给页面）
  globalThis.__pawchiveParse = { parsePost, scanPage, classifyLink, urlFilename, urlExt, inDateRange, filterCardsByDate, makeAuthorId };
})();
