/** Pawchive Downloader - 监控小窗：独立于网页的下载进度 / 暂停 / 继续 / 结束 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    statusLine: $('statusLine'),
    counts: $('counts'),
    pausedBox: $('pausedBox'),
    pausedText: $('pausedText'),
    btnResume: $('btnResume'),
    btnPause: $('btnPause'),
    btnResume2: $('btnResume2'),
    btnStop: $('btnStop'),
    btnReset: $('btnReset'),
    activeCount: $('activeCount'),
    active: $('active'),
    queueCount: $('queueCount'),
    pending: $('pending'),
    items: $('items'),
    fails: $('fails'),
    failCount: $('failCount'),
    diag: $('diag')
  };

  let stLast = null;

  const STATE_TXT = {
    sending: '发送中', downloading: '下载中', done: '✓',
    failed: '✗', interrupted: '中断', retry: '↻'
  };

  function tag(html, cls) {
    const s = document.createElement('span');
    s.className = 'tag' + (cls ? ' ' + cls : '');
    s.innerHTML = html;
    return s;
  }

  function bar(received, total) {
    const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
    const wrap = document.createElement('div');
    wrap.className = 'bar-wrap';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = pct + '%';
    const txt = document.createElement('span');
    txt.className = 'bar-txt';
    txt.textContent = total > 0 ? `${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)}MB ${pct}%` : `${(received / 1048576).toFixed(1)}MB`;
    wrap.append(fill, txt);
    return wrap;
  }

  function render(st) {
    stLast = st;
    // 状态行
    if (st.paused) {
      els.statusLine.textContent = `已暂停（${st.pauseReason || '手动暂停'}）`;
      els.statusLine.style.color = 'var(--warn)';
    } else if (st.running) {
      els.statusLine.textContent = st.cooldownUntil > Date.now()
        ? `限流冷却中，${Math.ceil((st.cooldownUntil - Date.now()) / 1000)}s 后继续…`
        : '正在下载…';
      els.statusLine.style.color = '';
    } else {
      els.statusLine.textContent = st.queued > 0 ? '等待中' : '空闲';
      els.statusLine.style.color = '';
    }

    // 计数（按持久化完成数展示，SW 重启也不失真）
    els.counts.replaceChildren(
      tag(`待下载 <b>${st.queued}</b>`),
      tag(`在途 <b>${(st.active || []).length}</b>`),
      tag(`累计完成 <b>${st.doneCount ?? st.completed}</b>`, 'ok'),
      tag(`失败 <b>${st.failed + st.interrupted}</b>`, st.failed + st.interrupted ? 'warn' : ''),
      tag(`重试 <b>${st.retried}</b>`),
      ...(st.namingConflict ? [tag('⚠ 文件名被其他扩展改写', 'warn')] : [])
    );

    // 暂停框
    if (st.paused) {
      els.pausedBox.classList.remove('hidden');
      els.pausedText.textContent = `已暂停：${st.pauseReason || '手动暂停'}。` +
        `\n剩余 ${st.queued} 个任务已保存，处理后点「继续」即可续传。`;
      els.btnPause.disabled = true;
      els.btnResume2.classList.remove('hidden');
    } else {
      els.pausedBox.classList.add('hidden');
      els.btnResume2.classList.add('hidden');
      els.btnPause.disabled = st.queued === 0 && (st.active || []).length === 0;
    }
    els.btnStop.disabled = st.queued === 0 && (st.active || []).length === 0;

    // 正在下载（带进度条）
    const act = st.active || [];
    els.activeCount.textContent = String(act.length);
    if (!act.length) {
      els.active.innerHTML = '<div class="item"><span class="name" style="color:var(--dim)">—</span></div>';
    } else {
      els.active.replaceChildren(...act.map((a) => {
        const div = document.createElement('div');
        div.className = 'item';
        div.style.flexWrap = 'wrap';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = a.filename;
        div.append(name, bar(a.received, a.total));
        return div;
      }));
    }

    // 待下载（前 15）
    els.queueCount.textContent = String(st.queued);
    const pend = st.nextPending || [];
    if (!pend.length) {
      els.pending.innerHTML = '<div class="item"><span class="name" style="color:var(--dim)">—</span></div>';
    } else {
      els.pending.replaceChildren(...pend.map((f) => {
        const div = document.createElement('div');
        div.className = 'item';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = f;
        div.append(name);
        return div;
      }));
    }

    // 最近完成/失败（按文件聚合：一个文件只显示最新状态）
    const agg = new Map();   // filename -> {status}
    (st.items || []).forEach((it) => agg.set(it.filename, it.status));
    const uniq = [...agg.entries()].slice(-40).reverse();
    els.items.replaceChildren(...uniq.map(([filename, status]) => {
      const div = document.createElement('div');
      div.className = 'item';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = filename;
      const stEl = document.createElement('span');
      stEl.className = 'st-' + status;
      stEl.textContent = STATE_TXT[status] || status;
      div.append(name, stEl);
      return div;
    }));
    if (!uniq.length) {
      els.items.innerHTML = '<div class="item"><span class="name" style="color:var(--dim)">暂无</span></div>';
    }

    // 诊断（插件实际执行记录）
    const diag = st.diag || [];
    els.diag.replaceChildren(...diag.slice().reverse().map((d) => {
      const div = document.createElement('div');
      div.className = 'item';
      const t = document.createElement('span');
      t.className = 'diag-t';
      t.textContent = d.t;
      const txt = document.createElement('span');
      txt.className = 'name';
      txt.textContent = (d.type === 'done' ? '✓ ' : d.type === 'failed' ? '✗ ' : '· ') +
        (d.filename ? d.filename + (d.bytes !== undefined ? ' (' + (d.bytes / 1048576).toFixed(2) + 'MB)' : '') : '') +
        (d.detail ? d.detail : '') + (d.error ? ' [' + d.error + ']' : '') + (d.via ? ' [' + d.via + ']' : '');
      div.append(t, txt);
      return div;
    }));
    if (!diag.length) {
      els.diag.innerHTML = '<div class="item"><span class="name" style="color:var(--dim)">暂无</span></div>';
    }

    // 失败明细
    const fails = st.failedJobs || [];
    els.failCount.textContent = String(fails.length);
    els.fails.replaceChildren(...fails.slice().reverse().map((f) => {
      const div = document.createElement('div');
      div.className = 'item';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = f.filename;
      const err = document.createElement('span');
      err.className = 'st-failed';
      err.textContent = f.error || '✗';
      err.title = f.error || '';
      div.append(name, err);
      return div;
    }));
    if (!fails.length) {
      els.fails.innerHTML = '<div class="item"><span class="name" style="color:var(--dim)">无</span></div>';
    }
  }

  async function poll() {
    try {
      const st = await chrome.runtime.sendMessage({ type: 'pawchiveGetState' });
      if (st) render(st);
    } catch (e) { /* SW 未就绪，下一轮再试 */ }
  }

  els.btnPause.addEventListener('click', async () => {
    els.btnPause.disabled = true;
    try { await chrome.runtime.sendMessage({ type: 'pawchivePauseQueue' }); } catch (e) { /* ignore */ }
    poll();
  });

  els.btnResume.addEventListener('click', async () => {
    els.btnResume.disabled = true;
    try { await chrome.runtime.sendMessage({ type: 'pawchiveResumeQueue' }); } catch (e) { /* ignore */ }
    els.btnResume.disabled = false;
    poll();
  });

  els.btnResume2.addEventListener('click', async () => {
    els.btnResume2.disabled = true;
    try { await chrome.runtime.sendMessage({ type: 'pawchiveResumeQueue' }); } catch (e) { /* ignore */ }
    els.btnResume2.disabled = false;
    poll();
  });

  let stopArmed = false;
  els.btnStop.addEventListener('click', async () => {
    if (!stopArmed && stLast && (stLast.queued > 0 || (stLast.active || []).length > 0)) {
      // 有任务时需二次确认
      stopArmed = true;
      els.btnStop.textContent = '确认结束？';
      setTimeout(() => { stopArmed = false; els.btnStop.textContent = '■ 结束下载'; }, 4000);
      return;
    }
    stopArmed = false;
    els.btnStop.textContent = '■ 结束下载';
    try { await chrome.runtime.sendMessage({ type: 'pawchiveStopQueue' }); } catch (e) { /* ignore */ }
    poll();
  });

  let resetArmed = false;
  els.btnReset.addEventListener('click', async () => {
    if (!resetArmed) {
      resetArmed = true;
      els.btnReset.textContent = '确认清空？（再次点击）';
      setTimeout(() => { resetArmed = false; els.btnReset.textContent = '清空下载记录'; }, 4000);
      return;
    }
    resetArmed = false;
    els.btnReset.textContent = '清空下载记录';
    try { await chrome.runtime.sendMessage({ type: 'pawchiveResetRecords' }); } catch (e) { /* ignore */ }
    poll();
  });

  poll();
  setInterval(poll, 500);
})();
