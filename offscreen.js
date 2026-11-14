// Offscreen 文档：把字节生成 Blob URL，交给后台统一发起下载。
// 不在本页注册 onDeterminingFilename —— 命名统一由 background 的监听器负责。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'pwSaveBlob') return;
  (async () => {
    let url = '';
    try {
      const bytes = Uint8Array.from(atob(msg.b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: msg.mime || 'application/octet-stream' });
      url = URL.createObjectURL(blob);
      // 后台用 downloads.download 下载这个 blob URL，并在 onDeterminingFilename 里给出目标路径
      const res = await chrome.runtime.sendMessage({
        type: 'pwDownloadBlobUrl', url, filename: msg.filename
      });
      sendResponse(res || { ok: false, error: (globalThis.PawLang ? PawLang.pick('后台无响应', 'background did not respond') : 'background did not respond') });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    } finally {
      if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 1000);
    }
  })();
  return true;   // 异步 sendResponse
});
