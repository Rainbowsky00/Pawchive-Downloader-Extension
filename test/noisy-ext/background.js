// 测试用“干扰扩展”：模拟下载管理器类扩展，注册 onDeterminingFilename。
// 仅用于验证：其他扩展注册该监听后，downloads.download 的 filename 会被 Chromium 忽略。
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  suggest({ filename: 'NOISY_' + (item.filename || 'file.jpg'), conflictAction: 'overwrite' });
});
