/** background.js 逻辑桩测试：命名规则、补零、emoji 清理、links.txt、去重、持久化 */
const fs = require('fs');
const path = require('path');

const captured = [];
const dlListeners = [];
const dlState = { hold: false, held: [], fireState: null };
const memStorage = { data: {} };
globalThis.__pwTestFast = true;
   // 跳过限速间隔

// fetch 桩：返回 1KB 假二进制；可切换为 429 / 404
const fetchState = { mode: 'ok' };
globalThis.fetch = async (url) => {
  if (fetchState.mode === '429') return { ok: false, status: 429, headers: new Headers() };
  if (fetchState.mode === '404') return { ok: false, status: 404, headers: new Headers() };
  const body = new Uint8Array(1024).fill(7);
  return {
    ok: true, status: 200,
    headers: new Headers({ 'content-type': 'image/jpeg' }),
    arrayBuffer: async () => body.buffer,
  };
};

globalThis.chrome = {
  declarativeNetRequest: {
    updateSessionRules() {},
    getSessionRules() { return Promise.resolve([]); }
  },
  runtime_getContexts_offscreen: true,
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { listeners: [], addListener(fn) { this.listeners.push(fn); } },
    onConnect: { addListener() {} },
    // offscreen 模拟：pwSaveBlob 消息立即回 ack（测试桩环境无真实 offscreen 文档）
    sendMessage(msg) {
      if (msg && msg.type === 'pwSaveBlob') {
        setTimeout(() => {
          this.onMessage.listeners.forEach((fn) => fn({ type: 'pwSaveBlobAck', id: msg.id, ok: true }));
        }, 0);
      }
      return Promise.resolve(undefined);
    },
    lastError: null,
    getPlatformInfo(cb) { if (cb) cb({}); return Promise.resolve({}); },
    getURL(p) { return 'chrome-extension://test/' + p; },
    getContexts(cfg) { return Promise.resolve([]); }   // 单测环境无 offscreen 文档
  },
  offscreen: {
    createDocument(cfg) { return Promise.resolve(); }
  },
  storage: {
    local: {
      get(keys) {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in memStorage.data) out[k] = memStorage.data[k]; });
        return Promise.resolve(out);
      },
      set(obj) { Object.assign(memStorage.data, obj); return Promise.resolve(); },
      remove(keys) {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete memStorage.data[k]; });
        return Promise.resolve();
      }
    }
  },
  windows: {
    create: async () => ({ id: 1 }),
    get: async () => ({ id: 1 }),
    update: async () => ({}),
    onRemoved: { addListener() {} }
  },
  downloads: {
    // 同步模拟：download() 立即接受并立即触发 complete 事件（hold 模式下挂起待 release）
    download(opts, cb) {
      const id = captured.length + 1000;
      captured.push(Object.assign({ _id: id }, opts));
      if (dlState.hold) dlState.held.push(id);   // 先登记 hold，再触发回调（search 兜底需要）
      cb(id);
      if (dlState.hold) return;
      if (dlState.fireState) {
        dlListeners.forEach((fn) => fn({
          id,
          state: { current: dlState.fireState },
          error: dlState.fireState === 'interrupted' ? { current: 'SERVER_FAILED' } : undefined
        }));
        return;
      }
      const bytes = dlState.zeroBytes ? 0 : 2048;
      dlListeners.forEach((fn) => fn({
        id,
        state: { current: 'complete' },
        bytesReceived: { previous: bytes, current: bytes }
      }));
    },
    removeFile(id, cb) { if (cb) cb(); },
    erase(query, cb) { if (cb) cb([]); },
    cancel(id, cb) { if (cb) cb(); },
    search(query, cb) {
      const id = query && query.id;
      const it = captured.find((c) => c._id === id);
      if (it && dlState.hold && dlState.held.includes(id)) {
        cb([{ id, state: 'in_progress' }]);   // hold 模式：挂起的任务不报完成
        return;
      }
      if (it && dlState.fireState) {
        // 与 fireState 一致：注入的失败状态也会被 search 兜底读到
        cb([{ id, state: dlState.fireState, error: dlState.fireState === 'interrupted' ? 'SERVER_FAILED' : '' }]);
        return;
      }
      cb(it ? [{ id, state: 'complete', bytesReceived: 2048 }] : []);
    },
    onChanged: {
      addListener(fn) { dlListeners.push(fn); },
      removeListener(fn) { const i = dlListeners.indexOf(fn); if (i >= 0) dlListeners.splice(i, 1); }
    }
  }
};

const src = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
// 同一个 eval 内导出引用（间接 eval 的 const 不会进入全局词法环境）
(0, eval)(src + '\n;globalThis.__bg = { state, queue, doneSet, postStats };');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}\n      expected ${e}\n      actual   ${a}`); }
}

const sleepMsWrap = (ms) => new Promise((r) => setTimeout(r, ms));

function releaseHeld() {
  const ids = dlState.held.splice(0);
  ids.forEach((id) => dlListeners.forEach((fn) => fn({ id, state: { current: 'complete' } })));
}

// 等待并发泵真正排空（限速节拍引入真实定时器，需轮询）
async function drain() {
  const bg = () => globalThis.__bg;
  for (let i = 0; i < 400; i++) {
    if (bg() && bg().queue.length === 0 && !bg().state.running) {
      await new Promise((r) => setTimeout(r, 30));
      if (bg().queue.length === 0 && !bg().state.running) return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
const clearDone = () => globalThis.__bg.doneSet.clear();

(async () => {
  /* 1. 补零规则 */
  eq([1, 5, 9].map(i => padIndex(i, 9)), ['1', '5', '9'], '9 个以内：1-9 无补零');
  eq([1, 9, 10, 25, 99].map(i => padIndex(i, 99)), ['01', '09', '10', '25', '99'], '10-99：前 9 个补 0');
  eq([1, 9, 10, 99, 100, 150, 999].map(i => padIndex(i, 150)), ['001', '009', '010', '099', '100', '150', '999'], '100-999：1-9 补 00，10-99 补 0');
  eq([1, 9, 10, 99, 100, 999, 1000].map(i => padIndex(i, 1000)), ['0001', '0009', '0010', '0099', '0100', '0999', '1000'], '1000：补 0 宽度 4');

  /* 2. emoji / 非法字符清理 */
  eq(stripEmoji('🔥Test “title” with emoji😀🫡~'), 'Test “title” with emoji~', 'emoji 全部移除，普通标点保留');
  eq(sanitizeText('A steamy bath~', 80), 'A steamy bath~', '普通标题不变');
  eq(sanitizeText('Re: File/Update? *Beta* v1.0.', 80), 'Re File Update Beta v1.0', '非法字符替换、结尾点清除');
  eq(sanitizeText('很长'.repeat(60), 80).length, 80, '标题限长 80');

  /* 3. 路径拼接 */
  eq(joinPath(['', 'Kouki', '2026-11-09-A steamy bath~']), 'Kouki/2026-11-09-A steamy bath~', '根目录为空时无多余段');
  eq(joinPath(['Pawchive', 'Kouki', 'sub']), 'Pawchive/Kouki/sub', '根目录保留');
  eq(joinPath(['a/b', '..\\c', 'd']), 'a/b/c/d', '根目录允许多级且去掉 ..');

  /* 4. 完整帖子入队（真实 example 数据） */
  const payload = {
    kind: 'post',
    pageUrl: 'https://pawchive.pw/patreon/user/69106319/post/174845157',
    service: 'patreon', userId: '69106319', postId: '174845157',
    author: 'Kouki',
    title: '"A steamy bath~"',
    date: '2026-11-09',
    images: [
      { url: 'https://n3.pawchive.pw/data/a/1.jpeg?f=IMG_4566.jpeg', filename: 'IMG_4566.jpeg', ext: 'jpeg' },
      { url: 'https://n3.pawchive.pw/data/a/2.jpeg?f=IMG_4567.jpeg', filename: 'IMG_4567.jpeg', ext: 'jpeg' },
      { url: 'https://n1.pawchive.pw/data/a/3.jpeg?f=IMG_4568.jpeg', filename: 'IMG_4568.jpeg', ext: 'jpeg' },
      { url: 'https://n1.pawchive.pw/data/a/4.jpeg?f=IMG_4569.jpeg', filename: 'IMG_4569.jpeg', ext: 'jpeg' },
      { url: 'https://n4.pawchive.pw/data/a/5.jpeg?f=IMG_4570.jpeg', filename: 'IMG_4570.jpeg', ext: 'jpeg' }
    ],
    videos: [{ url: 'https://n4.pawchive.pw/data/z/w/hash2.mp4?f=clip.mp4', filename: 'clip.mp4' }],
    attach: [],
    links: {
      drive: ['https://mega.nz/file/abc', 'https://www.dropbox.com/s/xyz/file.zip'],
      video: [{ url: 'https://n1.pawchive.pw/data/1/2/abc.mp4', filename: 'abc.mp4' }],
      attach: []
    }
  };

  enqueuePost(payload, { rename: true, root: '' });
  await drain();
  eq(captured.length, 8, '5 图 + 2 视频 + 1 links.txt = 8 个任务');
  const files = captured.map(c => c.filename);
  eq(files.slice(0, 7), [
    'Kouki/2026-11-09-A steamy bath~/1.jpeg',
    'Kouki/2026-11-09-A steamy bath~/2.jpeg',
    'Kouki/2026-11-09-A steamy bath~/3.jpeg',
    'Kouki/2026-11-09-A steamy bath~/4.jpeg',
    'Kouki/2026-11-09-A steamy bath~/5.jpeg',
    'Kouki/2026-11-09-A steamy bath~/6.mp4',
    'Kouki/2026-11-09-A steamy bath~/7.mp4'
  ], '重命名模式：图片与视频按顺序统一编号 1-7（扩展名保留）');
  const txtJob = captured.find(c => c.filename.endsWith('links.txt'));
  eq(!!txtJob, true, '生成 links.txt');
  if (txtJob) {
    const txt = decodeURIComponent(txtJob.url.replace('data:text/plain;charset=utf-8,', ''));
    eq(/【云盘链接】 ?\(2\)|【Cloud storage links】 ?\(2\)|\[云盘链接\] ?\(2\)|\[Cloud storage links\] ?\(2\)/.test(txt) && txt.includes('https://mega.nz/file/abc'), true, 'txt 含云盘链接段');
    eq(/【视频链接】 ?\(1\)|【Video links】 ?\(1\)|\[视频链接\] ?\(1\)|\[Video links\] ?\(1\)/.test(txt) && txt.includes('abc.mp4'), true, 'txt 含视频链接段');
    eq(/帖子[：:]|"A steamy bath~"|Post[：:]/.test(txt) && /作者[：:]|Author[：:]/.test(txt) && txt.includes('Kouki'), true, 'txt 头部含标题与作者');
  }

  /* 5. 不重命名模式 + emoji 标题 + 大数量补零 */
  const bigPayload = JSON.parse(JSON.stringify(payload));
  bigPayload.title = '🔥Emo😀ji 标题/测试?';
  bigPayload.images = Array.from({ length: 123 }, (_, i) => ({
    url: `https://n1.pawchive.pw/data/a/${i}.jpeg?f=pic${i}.jpeg`, filename: `pic${i}.jpeg`, ext: 'jpeg'
  }));
  bigPayload.videos = []; bigPayload.links = { drive: [], video: [], attach: [] };
  enqueuePost(bigPayload, { rename: true, root: 'Pawchive' });
  await drain();
  const bigFiles = captured.slice(8).map(c => c.filename);
  eq(bigFiles[0], 'Pawchive/Kouki/2026-11-09-Emoji 标题 测试/001.jpeg', '123 张：第 1 张补 00，emoji 与非法字符已清理');
  eq(bigFiles[9], 'Pawchive/Kouki/2026-11-09-Emoji 标题 测试/010.jpeg', '第 10 张补 0');
  eq(bigFiles[99], 'Pawchive/Kouki/2026-11-09-Emoji 标题 测试/100.jpeg', '第 100 张正常');
  eq(bigFiles.length, 123, '共 123 个任务');

  /* 6. 不重命名：保留 ?f= 原始文件名 */
  const smallPayload = JSON.parse(JSON.stringify(payload));
  smallPayload.images = smallPayload.images.slice(0, 3);
  smallPayload.videos = []; smallPayload.links = { drive: [], video: [], attach: [] };
  enqueuePost(smallPayload, { rename: false, root: '' });
  await drain();
  eq(captured.slice(131).map(c => c.filename), [
    'Kouki/2026-11-09-A steamy bath~/IMG_4566.jpeg',
    'Kouki/2026-11-09-A steamy bath~/IMG_4567.jpeg',
    'Kouki/2026-11-09-A steamy bath~/IMG_4568.jpeg'
  ], '不重命名：保留 ?f= 原始文件名');

  /* 7. 无视频无链接时不生成 txt + 重复入队去重 */
  const noLinks = JSON.parse(JSON.stringify(payload));
  noLinks.videos = []; noLinks.links = { drive: [], video: [], attach: [] };
  enqueuePost(noLinks, { rename: true, root: '' });
  await drain();
  eq(captured.length, 134, '重复入队被 doneSet 去重后：0 新任务（134 = 8+123+3）');

  clearDone();
  enqueuePost(noLinks, { rename: true, root: '' });
  await drain();
  eq(captured.length, 139, '清空 doneSet 后重新入队 5 个图片任务');
  eq(globalThis.__bg.state.deduped, 5, '去重计数 = 5');

  /* 8. 持久化：队列排空后 storage 无残留（等 400ms 防抖写入） */
  await new Promise((r) => setTimeout(r, 700));
  eq((memStorage.data.pawchiveDlQueue || []).length, 0, '队列排空后 storage 中无残留任务');

  /* 9. 同名帖子串档防护：同日期+标题但不同 postId → 自动加 [id] 后缀 */
  const dupA = JSON.parse(JSON.stringify(payload));
  dupA.postId = '7234424'; dupA.title = 'KEEP OUT!'; dupA.date = '2024-01-01';
  dupA.images = dupA.images.slice(0, 2); dupA.videos = []; dupA.links = { drive: [], video: [], attach: [] };
  captured.length = 0;
  enqueuePost(dupA, { rename: true, root: '' });
  await drain();
  eq(captured[0].filename, 'Kouki/2024-01-01-KEEP OUT!/1.jpeg', '首个帖子用基础目录');

  const dupB = JSON.parse(JSON.stringify(dupA));
  dupB.postId = '7146142';
  captured.length = 0;
  enqueuePost(dupB, { rename: true, root: '' });
  await drain();
  eq(captured[0].filename.startsWith('Kouki/2024-01-01-KEEP OUT! [7146142]/'), true, '同名不同帖自动加 [postId] 后缀');

  // 同一帖子重跑 → 回到同一目录（不会再加后缀）
  captured.length = 0;
  enqueuePost(dupB, { rename: true, root: '' });
  await drain();
  eq(captured.length, 0, '同帖重跑被 doneSet 全量去重（0 新任务）');
  captured.length = 0;
  clearDone();
  enqueuePost(dupB, { rename: true, root: '' });
  await drain();
  eq(captured[0].filename.startsWith('Kouki/2024-01-01-KEEP OUT! [7146142]/'), true, '清空去重后同帖仍用同一目录');

  /* 10. 队列级去重：未完成的任务重复入队只保留一份（直链挂起期间） */
  clearDone();
  captured.length = 0;
  dlState.hold = true;
  dlState.held.length = 0;
  const dedBefore = globalThis.__bg.state.deduped;
  enqueuePost(smallPayload, { rename: false, root: '' });
  await drain();
  const heldCount = captured.length;
  enqueuePost(smallPayload, { rename: false, root: '' });
  await drain();
  eq(globalThis.__bg.state.deduped - dedBefore, 3, '未完成任务的重复入队被 pendingSet 去重');
  dlState.hold = false;
  const compBefore = globalThis.__pawchiveBg.getState().completed;
  releaseHeld();
  await drain();
  eq(globalThis.__pawchiveBg.getState().completed - compBefore, 3, '放行后 3 个全部完成');

  /* 11.5 暂停：任务失败重试期间暂停 → 任务重新入队（不计失败），继续后完成 */
  clearDone();
  captured.length = 0;
  dlState.hold = false;
  dlState.fireState = 'interrupted';   // 所有下载尝试都瞬时失败（进入退避重试）
  enqueuePost(smallPayload, { rename: false, root: '' });
  await sleepMsWrap(40);               // 等首批尝试失败、进入退避
  const pausedRes = globalThis.__pawchiveBg.pause();
  await drain();
  dlState.fireState = null;
  const stPause = globalThis.__pawchiveBg.getState();
  console.log('   [pd]', JSON.stringify({ q: stPause.queued, c: stPause.completed, f: stPause.failed, items: stPause.items.map(function(i){ return [i.filename.split('/').pop(), i.status]; }) }));
  eq(stPause.paused, true, '暂停状态生效');
  eq(stPause.queued > 0, true, '暂停后任务保留在队列（待下载）');
  eq(stPause.failed, 0, '暂停不产生失败计数');
  // 继续（恢复正常完成）
  const resumeBase = stPause.doneCount;
  globalThis.__pawchiveBg.resume();
  await drain();
  const stResume = globalThis.__pawchiveBg.getState();
  eq(stResume.paused, false, '继续后暂停解除');
  eq(stResume.doneCount - resumeBase >= 1, true, '继续后任务完成');

  /* 12. 结束下载：清空剩余队列，已完成文件保留，在途自然收尾 */
  clearDone();
  captured.length = 0;
  dlState.hold = true;
  dlState.held.length = 0;
  enqueuePost(smallPayload, { rename: false, root: '' });
  await drain();
  const stopBase = captured.length;
  console.log('   [stop dbg] after drain captured:', JSON.stringify(captured.map(c => [c._id, c.filename.split('/').pop(), c.url.slice(0, 30)])), '/ held:', JSON.stringify(dlState.held), '/ queued:', globalThis.__bg.queue.length, '/ running:', globalThis.__bg.state.running);
  const stopped = globalThis.__pawchiveBg.stop();
  eq(stopped.stopped, true, 'stop() 返回成功');
  eq(globalThis.__bg.queue.length, 0, '队列已清空');
  eq((memStorage.data.pawchiveDlQueue || []).length, 0, '持久化队列已清除');
  eq(globalThis.__bg.state.queued, 0, '结束后待下载为 0');
  dlState.hold = false;
  releaseHeld();
  await drain();
  console.log('   [stop dbg] stopBase:', stopBase, '/ captured:', captured.length, '/ completed:', globalThis.__pawchiveBg.getState().completed, '/ held:', JSON.stringify(dlState.held));
  const stStop = globalThis.__pawchiveBg.getState();
  eq(captured.length, stopBase, '结束后无新增下载派发（排队任务已取消）');
  eq(stStop.doneCount, 2, '在途 2 个自然完成');


  /* 逐帖状态：入队返回 postKey，全部结案后 pending 归零 */
  clearDone();
  dlState.hold = true;
  dlState.held = [];
  const trackPayload = {
    kind: 'post', postId: 'track1', author: 'A', title: 'Track', date: '2026-01-01',
    images: [
      { url: 'https://track.test/1.jpg', filename: '1.jpg', ext: 'jpg' },
      { url: 'https://track.test/2.jpg', filename: '2.jpg', ext: 'jpg' },
      { url: 'https://track.test/3.jpg', filename: '3.jpg', ext: 'jpg' }
    ],
    videos: [], media: [], attach: [], links: { drive: [], video: [], attach: [] }
  };
  const tracked = enqueuePost(trackPayload, { rename: true, root: '' });
  eq(tracked.jobs, 3, '逐帖入队返回 jobs=3');
  eq(typeof tracked.postKey, 'string', '逐帖入队返回 postKey');
  const ts0 = globalThis.__bg.postStats.get(tracked.postKey);
  eq([ts0.total, ts0.pending, ts0.done], [3, 3, 0], '入队后该帖 pending=3');
  dlState.hold = false;
  releaseHeld();
  await drain();
  const ts1 = globalThis.__bg.postStats.get(tracked.postKey);
  eq([ts1.pending, ts1.done, ts1.failed], [0, 3, 0], '该帖全部完成后 pending=0');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('TEST FATAL', e); process.exit(1); });
