// 测试用“晚初始化”的干扰扩展：模拟 Bulk Image Downloader 在浏览器启动约 6 秒后
// 才注册 onDeterminingFilename，从而覆盖其他扩展此前注册的监听。
setTimeout(() => {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    suggest({ filename: 'NOISY2_' + (item.filename || 'file.jpg'), conflictAction: 'overwrite' });
  });
}, 6000);
