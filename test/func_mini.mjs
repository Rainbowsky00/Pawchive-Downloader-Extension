// 功能自检（离线）：data URL 走完整管线
// 验证：监控小窗自动打开、统一编号命名、暂停/继续、重置记录
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT = decodeURI(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const PROFILE = path.join(os.tmpdir(), 'pw-func-profile');
const DL = path.join(os.tmpdir(), 'pawchive-dl-' + Date.now());

for (const dir of [PROFILE, DL]) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
fs.writeFileSync(path.join(PROFILE, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: DL, prompt_for_download: false },
}));

const BROWSER = process.env.PW_BROWSER === 'edge'
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Google/Chrome/Application/chrome.exe';
console.log('browser:', BROWSER);
const child = spawn(BROWSER, [
  `--user-data-dir=${PROFILE}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

let buf = Buffer.alloc(0);
const pending = new Map();
let seq = 0;
child.stdio[4].on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  let i;
  while ((i = buf.indexOf(0)) !== -1) {
    const raw = buf.subarray(0, i).toString('utf8');
    buf = buf.subarray(i + 1);
    if (!raw.trim()) continue;
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const mid = ++seq;
  pending.set(mid, res);
  child.stdio[3].write(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const ev = async (expr, sid) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  if (r.error) throw new Error(r.error.message);
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 构造假帖子：2 图 + 1 视频（全部 data URL），带 1 个网盘链接触发 links.txt
const mkData = (n, mime) => {
  const bytes = Buffer.alloc(n, 0x61);
  return `data:${mime};base64,` + bytes.toString('base64');
};
const payload = {
  kind: 'post',
  pageUrl: 'https://pawchive.pw/fanbox/user/1/post/111',
  service: 'fanbox', userId: '1', postId: '111',
  author: '自检作者',
  title: '编号与暂停自检😀',
  date: '2026-01-01',
  images: [
    { url: mkData(500, 'image/jpeg'), filename: 'orig_a.jpg', ext: 'jpg' },
    { url: mkData(500, 'image/png'), filename: 'orig_b.png', ext: 'png' },
  ],
  videos: [{ url: mkData(300, 'video/mp4'), filename: 'orig_c.mp4', ext: 'mp4' }],
  media: [
    { url: mkData(500, 'image/jpeg'), filename: 'orig_a.jpg', ext: 'jpg', kind: 'image' },
    { url: mkData(300, 'video/mp4'), filename: 'orig_c.mp4', ext: 'mp4', kind: 'video' },
    { url: mkData(500, 'image/png'), filename: 'orig_b.png', ext: 'png', kind: 'image' },
  ],
  attach: [],
  links: { drive: ['https://mega.nz/file/selfcheck'], video: [], attach: [] }
};

let passed = 0, failed = 0;

  async function waitDrain(sid, before, expect) {
    let st = null;
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      st = await ev('__pawchiveBg.getState()', sid);
      if (!st.running && st.queued === 0 && (st.completed + st.failed) >= before + expect) return st;
    }
    return st;
  }

const check = (ok, label) => { ok ? (passed++, console.log('  ok ', label)) : (failed++, console.log('FAIL ', label)); };

(async () => {
  await sleep(2000);
  const load = await send('Extensions.loadUnpacked', { path: EXT });
  const extId = load.result?.id;
  const t = await send('Target.createTarget', { url: `chrome-extension://${extId}/popup/popup.html` });
  await sleep(1500);
  await send('Target.closeTarget', { targetId: t.result.targetId });
  await sleep(800);
  const targets = await send('Target.getTargets');
  const sw = targets.result.targetInfos.find((x) => x.type === 'service_worker' && x.url === `chrome-extension://${extId}/background.js`);
  const att = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  const sid = att.result.sessionId;

  // 1. 入队假帖子（重命名开）
  const r1 = await ev(`__pawchiveBg.enqueue(${JSON.stringify(payload)}, { rename: true, root: '' })`, sid);
  check(r1 && r1.ok && r1.jobs === 4, `入队 4 个任务（3 媒体 + 1 txt）：${JSON.stringify(r1)}`);

  // 2. 等排空
  let st = await waitDrain(sid, 0, 4);
  check(st.completed === 4, `4 个任务完成（completed=${st.completed}）`);
  check(st.failed === 0, `0 失败`);

  // 3. 监控小窗自动打开
  const tg = await send('Target.getTargets');
  const miniOpen = tg.result.targetInfos.some((x) => (x.url || '').includes('mini/mini.html'));
  check(miniOpen, '监控小窗已自动打开');

  // 小窗 DOM 渲染了计数
  const miniTarget = tg.result.targetInfos.find((x) => (x.url || '').includes('mini/mini.html'));
  const miniSid = (await send('Target.attachToTarget', { targetId: miniTarget.targetId, flatten: true })).result.sessionId;
  await sleep(800);
  const countsText = await ev('document.getElementById("counts").innerText.replace(/\\n/g, " ")', miniSid);
  check(/待下载/.test(countsText) && /累计完成/.test(countsText), `小窗渲染计数：${countsText}`);

  // 4. 磁盘命名：统一编号（media 顺序：图、视频、图）+ links.txt
  const folder = path.join(DL, '自检作者', '2026-01-01-编号与暂停自检');
  await sleep(500);
  const names = fs.existsSync(folder) ? fs.readdirSync(folder).sort() : [];
  check(JSON.stringify(names) === JSON.stringify(['1.jpg', '2.mp4', '3.png', 'links.txt']),
    `文件夹内文件名 = 1.jpg/2.mp4/3.png/links.txt（实际：${names.join(', ')}）`);

  // 5. 暂停/继续：再入队 6 个慢任务（fetch 桩不可用——用大 data URL 让下载稍慢不可靠，
  //    改用直接验证 pause/resume 状态机）
  await ev(`__pawchiveBg.pause()`, sid);
  st = await ev('__pawchiveBg.getState()', sid);
  check(st.paused === true && st.pauseReason === '手动暂停', '手动暂停生效');
  // 队列空时暂停也应可继续
  await ev(`__pawchiveBg.resume()`, sid);
  st = await ev('__pawchiveBg.getState()', sid);
  check(st.paused === false, '继续后暂停解除');

  // 6. 再入队一批（第二次 enqueuePost 不应再开第二个小窗）
  const payload2 = JSON.parse(JSON.stringify(payload));
  payload2.postId = '222'; payload2.title = '第二帖';
  payload2.media = payload.media.map((m) => ({ ...m }));
  payload2.images = payload.images.map((i) => ({ ...i }));
  payload2.videos = payload.videos.map((v) => ({ ...v }));
  const before2 = st.completed + st.failed;
  await ev(`__pawchiveBg.enqueue(${JSON.stringify(payload2)}, { rename: true, root: '' })`, sid);
  st = await waitDrain(sid, before2, 4);
  const tg2 = await send('Target.getTargets');
  const miniCount = tg2.result.targetInfos.filter((x) => (x.url || '').includes('mini/mini.html')).length;
  check(miniCount === 1, `小窗不重复打开（${miniCount} 个）`);
  const folder2 = path.join(DL, '自检作者', '2026-01-01-第二帖');
  const names2 = fs.existsSync(folder2) ? fs.readdirSync(folder2).sort() : [];
  check(JSON.stringify(names2) === JSON.stringify(['1.jpg', '2.mp4', '3.png', 'links.txt']),
    `第二帖独立目录且同样命名（${names2.join(', ')}）`);

  // 7. 同名不同 postId 的串档防护
  const payload3 = JSON.parse(JSON.stringify(payload));
  payload3.postId = '333';
  const before3 = st.completed + st.failed;
  await ev(`__pawchiveBg.enqueue(${JSON.stringify(payload3)}, { rename: true, root: '' })`, sid);
  st = await waitDrain(sid, before3, 4);
  const folder3 = path.join(DL, '自检作者', '2026-01-01-编号与暂停自检 [333]');
  check(fs.existsSync(folder3), '同日期标题不同帖自动加 [postId] 后缀目录');

  // 8. 重置记录：doneSet 清空后重入队会重新下载
  await ev(`__pawchiveBg.reset()`, sid);
  const r4 = await ev(`__pawchiveBg.enqueue(${JSON.stringify(payload)}, { rename: true, root: '' })`, sid);
  check(r4.jobs === 4, `重置记录后重入队 4 个任务（${JSON.stringify(r4)}）`);
  st = await waitDrain(sid, 0, 4);   // reset 已把计数器清零，基线为 0
  check(st && st.completed >= 4 && st.failed === 0, '重置后 4 个任务重新下载完成');

  console.log(`\n${passed} passed, ${failed} failed`);
  await send('Browser.close');
  await sleep(1200);
  child.kill();
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FUNC FAIL', e); child.kill(); process.exit(1); });
