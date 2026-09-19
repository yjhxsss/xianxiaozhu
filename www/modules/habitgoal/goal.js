import { DB, State, save, snapshotDelete, undo } from '../../core/db.js';
import { esc, today, uid, clamp, diffDays, fmtD } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';
import { AIHub } from '../diary/ai.js';

export function getGoals() {
  return DB.goals.filter(g => g.user_id === State.user.id);
}

function calcProgress(g) {
  if (g.type === 'quant') {
    const total = (g.records || []).reduce((s, r) => s + (parseFloat(r.value) || 0), 0);
    const target = parseFloat(g.target_total) || 0;
    const pct = target > 0 ? clamp(Math.round(total / target * 100), 0, 100) : 0;
    return { current: total, pct, hasTarget: target > 0 };
  }
  return { current: null, pct: clamp(Math.round(g.progress || 0), 0, 100), hasTarget: true };
}

function isDone(g) { return calcProgress(g).pct >= 100; }

function deadlineState(g) {
  if (!g.deadline) return { state: 'none', label: '' };
  if (isDone(g)) return { state: 'none', label: '' };
  const diff = diffDays(g.deadline, today());
  if (diff < 0) return { state: 'overdue', label: `⚠ 逾期 ${-diff} 天` };
  if (diff === 0) return { state: 'soon', label: '⏰ 今天截止' };
  if (diff <= 3) return { state: 'soon', label: `⏰ 剩 ${diff} 天` };
  return { state: 'normal', label: `📅 剩 ${diff} 天` };
}

function fmtNum(n) {
  if (n == null) return '0';
  const x = parseFloat(n);
  if (isNaN(x)) return '0';
  return Number.isInteger(x) ? String(x) : x.toFixed(1).replace(/\.0$/, '');
}

export function renderPanel(goals) {
  const sorted = [...goals].sort((a, b) => {
    if (isDone(a) !== isDone(b)) return isDone(a) ? 1 : -1;
    if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });

  return `
    <div class="panel">
      <div class="panel-title">
        <span class="title-icon">🎯</span>目标
        <button class="btn btn-xs btn-primary" data-action="goal-add" type="button" style="margin-left:auto">+ 添加</button>
      </div>
      <div id="goalListBody">
        ${sorted.length ? sorted.map((g, i) => renderGoalCard(g, i)).join('') : '<div class="done-empty">暂无目标，点右上角添加 🎯</div>'}
      </div>
    </div>`;
}

function renderGoalCard(g, index) {
  const prog = calcProgress(g);
  const dl = deadlineState(g);
  const expanded = State.expandedGoalId === g.id;
  const linkedTodos = DB.todos.filter(t => t.goalId === g.id);
  const linkedDone = linkedTodos.filter(t => t.completed).length;
  const cls = [
    g.completed ? 'completed' : '',
    dl.state === 'overdue' ? 'overdue' : '',
    dl.state === 'soon' ? 'soon' : '',
    expanded ? 'expanded' : ''
  ].filter(Boolean).join(' ');

  const statusIcon = g.completed ? '✅' : (dl.state === 'overdue' ? '⚠️' : '⭕');
  const quantBadge = g.type === 'quant' && prog.hasTarget
    ? `<span class="goal-quant-badge">${fmtNum(prog.current)}/${fmtNum(parseFloat(g.target_total))}${esc(g.unit || '')}</span>`
    : (g.type === 'quant' ? `<span class="goal-quant-badge">${fmtNum(prog.current)}${esc(g.unit || '')}</span>` : '');

  const metaLeft = g.completed ? '✅ 已达成' : `进度 ${prog.pct}%`;
  const metaRight = dl.label ? `<span class="deadline ${dl.state}">${esc(dl.label)}</span>` : '';

  const isDoneNow = prog.pct >= 100;

  return `
    <div class="goal-item ${cls}${isDoneNow ? ' just-done' : ''}" data-id="${g.id}" style="--i:${index || 0}">
      <div class="goal-head" data-action="goal-expand" data-id="${g.id}">
        <span class="goal-status-icon">${statusIcon}</span>
        <span class="goal-title-text">${esc(g.title)}</span>
        ${quantBadge}
        <span class="goal-expand-icon">▼</span>
      </div>
      <div class="goal-progress"><div class="goal-fill" style="width:${prog.pct}%"></div></div>
      <div class="goal-meta">
        <span>${metaLeft}${linkedTodos.length ? ` · 🔗 关联待办 ${linkedDone}/${linkedTodos.length}` : ''}</span>
        <span class="goal-actions">${metaRight}
          <button class="btn btn-xs btn-ghost" data-action="goal-edit" data-id="${g.id}" type="button">✎ 编辑</button>
          <button class="btn btn-xs btn-danger" data-action="goal-del" data-id="${g.id}" type="button">删</button>
        </span>
      </div>
      ${expanded ? renderDetail(g, prog) : ''}
    </div>`;
}

function renderDetail(g, prog) {
  if (g.type === 'quant') {
    const records = (g.records || []).slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return `
      <div class="goal-detail">
        <div class="goal-record-row">
          <input type="number" class="input" id="grVal_${g.id}" placeholder="数值" step="0.1" style="width:88px">
          <input type="text" class="input" id="grNote_${g.id}" placeholder="备注（可选）" style="flex:1;min-width:100px">
          <button class="btn btn-sm btn-primary" data-action="goal-quant-add" data-id="${g.id}" type="button">+ 记录</button>
          <button class="btn btn-sm btn-ghost" data-action="goal-ai-decompose" data-id="${g.id}" type="button" title="用 AI 拆解成小待办">🤖 AI 拆解</button>
        </div>
        <div class="goal-records">
          ${records.length
            ? records.map(r => {
              const isFromTodo = r.source === 'todo';
              const isFromHealth = typeof r.source === 'string' && r.source.startsWith('health:');
              return `
              <div class="goal-record-item${isFromTodo || isFromHealth ? ' from-todo' : ''}">
                <span class="gr-val">+${fmtNum(r.value)}${esc(g.unit || '')}</span>
                <span class="gr-note">
                  ${isFromTodo ? '<span class="gr-source-tag" title="来自待办">📋 待办</span>' : ''}
                  ${isFromHealth ? '<span class="gr-source-tag" title="来自健康">💚 健康</span>' : ''}
                  ${r.note ? esc(r.note) : '<i style="color:var(--text-muted)">—</i>'}
                </span>
                <span class="gr-date">${esc(r.date || '')}</span>
                <button class="btn btn-xs btn-ghost" data-action="goal-quant-del" data-id="${g.id}" data-rid="${r.id}" type="button">✕</button>
              </div>`;
            }).join('')
            : '<div class="goal-record-empty">还没有记录，加一笔吧 ✨</div>'}
        </div>
      </div>`;
  }
  return `
    <div class="goal-detail">
      <div class="goal-record-row">
        <label style="font-size:12px;color:var(--text-sec);font-weight:600">调整进度</label>
        <input type="number" class="input goal-progress-edit" data-id="${g.id}" min="0" max="100"
               value="${g.progress || 0}" style="width:70px">
        <span style="font-size:12px;color:var(--text-muted);font-weight:600">%</span>
        <button class="btn btn-sm btn-ghost" data-action="goal-ai-decompose" data-id="${g.id}" type="button" title="用 AI 拆解成小待办" style="margin-left:auto">🤖 AI 拆解</button>
      </div>
      <div class="goal-manual-hint">💡 进度到 100% 会自动标记为已达成；调回小于 100 会重新打开。</div>
    </div>`;
}

export const actions = {
  'goal-add': () => openModal(),
  'goal-edit': (el) => {
    const g = DB.goals.find(x => x.id === el.dataset.id);
    if (g) openModal(g);
  },
  'goal-save': () => {
    const idEl = document.getElementById('gId');
    const id = idEl ? idEl.value : '';
    const title = document.getElementById('gTitle').value.trim();
    const type = document.getElementById('gType').value;
    const deadline = document.getElementById('gDeadline').value || null;
    if (!title) { toast('请输入目标名称', 'warning'); return; }

    if (id) {
      const g = DB.goals.find(x => x.id === id);
      if (!g) return;
      g.title = title; g.type = type; g.deadline = deadline;
      if (type === 'manual') g.progress = clamp(parseInt(document.getElementById('gProgress').value) || 0, 0, 100);
      else {
        g.target_total = parseFloat(document.getElementById('gTotal').value) || 0;
        g.unit = document.getElementById('gUnit').value.trim();
        if (!g.records) g.records = [];
      }
      syncDone(g);
    } else {
      const g = {
        id: uid(), user_id: State.user.id, title, type,
        progress: 0, records: [], target_total: 0, unit: '',
        deadline, createdAt: new Date().toISOString(),
        completed: false, completedAt: null
      };
      if (type === 'manual') g.progress = clamp(parseInt(document.getElementById('gProgress').value) || 0, 0, 100);
      else {
        g.target_total = parseFloat(document.getElementById('gTotal').value) || 0;
        g.unit = document.getElementById('gUnit').value.trim();
      }
      syncDone(g);
      DB.goals.push(g);
    }
    save('goals');
    emit('db:changed');
    hideModal();
    toast('已保存', 'success');
    rerender();
  },
  'goal-expand': (el) => {
    const id = el.dataset.id;
    State.expandedGoalId = State.expandedGoalId === id ? null : id;
    rerender();
  },
  'goal-quant-add': (el) => {
    const g = DB.goals.find(x => x.id === el.dataset.id);
    if (!g || g.type !== 'quant') return;
    const valEl = document.getElementById('grVal_' + g.id);
    const noteEl = document.getElementById('grNote_' + g.id);
    const val = parseFloat(valEl ? valEl.value : '');
    if (isNaN(val) || val <= 0) { toast('请输入大于 0 的数值', 'warning'); return; }
    const note = noteEl ? noteEl.value.trim() : '';
    if (!g.records) g.records = [];
    g.records.push({ id: uid(), value: val, note, date: today(), createdAt: new Date().toISOString() });
    syncDone(g);
    save('goals');
    emit('db:changed');
    if (g.completed) toast('🎉 目标达成！', 'success');
    else toast(`已记录 +${val}${g.unit || ''}`, 'success');
    rerender();
  },
  'goal-quant-del': (el) => {
    const g = DB.goals.find(x => x.id === el.dataset.id);
    if (!g) return;
    if (!confirm('删除这条记录？')) return;
    const rid = el.dataset.rid;
    const idx = (g.records || []).findIndex(r => r.id === rid);
    if (idx < 0) return;
    const removedRecord = g.records[idx];
    g.records.splice(idx, 1);
    syncDone(g);
    save('goals');
    emit('db:changed');
    rerender();
    toast('已删除记录', 'success', {
      actions: [{
        label: '撤销',
        onClick: () => {
          g.records.splice(Math.min(idx, g.records.length), 0, removedRecord);
          syncDone(g);
          save('goals');
          emit('db:changed');
          toast('已恢复记录', 'success');
          rerender();
        }
      }]
    });
  },
  'goal-del': (el) => {
    const g = DB.goals.find(x => x.id === el.dataset.id);
    if (!g) return;
    if (!confirm('删除该目标？')) return;
    const removed = snapshotDelete('goals', el.dataset.id);
    if (!removed) return;
    if (State.expandedGoalId === el.dataset.id) State.expandedGoalId = null;
    save('goals');
    emit('db:changed');
    rerender();
    toast('已删除目标', 'success', {
      actions: [{
        label: '撤销',
        onClick: () => {
          if (undo()) {
            emit('db:changed');
            toast('已恢复目标', 'success');
            rerender();
          }
        }
      }]
    });
  },

  /* ⭐ AI 拆解：带 repeat */
  'goal-ai-decompose': async (el) => {
    if (!AIHub.isEnabled()) { toast('请先到设置启用 AI', 'warning'); return; }
    const g = DB.goals.find(x => x.id === el.dataset.id);
    if (!g) return;

    showModal('goalDecompose', `
      <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">🤖 AI 正在拆解「${esc(g.title)}」…</h3>
      <div class="ai-loading" style="padding:30px;text-align:center">
        <div style="font-size:32px;margin-bottom:8px">🤖</div>
        <div>正在生成可执行的小待办…</div>
      </div>
    `);

    try {
      const todos = await AIHub.decomposeGoal(g);
      if (!todos.length) throw new Error('AI 未返回任何待办');
      State._aiGoalDecompose = { goalId: g.id, todos, goal: g };
      hideModal();
      renderDecomposeResult();
    } catch (e) {
      hideModal();
      toast('拆解失败：' + e.message, 'error');
    }
  },

  'goal-ai-accept-todo': (el) => {
    const idx = parseInt(el.dataset.idx);
    const cached = State._aiGoalDecompose;
    if (!cached) return;

    const row = document.querySelector(`[data-decompose-idx="${idx}"]`);
    if (!row) return;
    const titleEl = row.querySelector('.decompose-title');
    const dateEl = row.querySelector('.decompose-date');
    const priEl = row.querySelector('.decompose-priority');
    const repeatEl = row.querySelector('.decompose-repeat');
    const contribEl = row.querySelector('.decompose-contrib');

    const title = titleEl ? titleEl.value.trim() : cached.todos[idx].title;
    const date = dateEl ? dateEl.value : cached.todos[idx].date;
    const priority = priEl ? priEl.value : cached.todos[idx].priority;
    const repeat = repeatEl ? repeatEl.value : (cached.todos[idx].repeat || 'none');
    const contribution = contribEl ? (parseFloat(contribEl.value) || 0) : (cached.todos[idx].contribution || 0);

    if (!title) { toast('标题不能为空', 'warning'); return; }

    DB.todos.push({
      id: uid(),
      user_id: State.user.id,
      title,
      date: date || today(),
      time: '09:00',
      priority: ['high', 'medium', 'low'].includes(priority) ? priority : 'medium',
      repeat: ['none', 'daily', 'weekly', 'monthly'].includes(repeat) ? repeat : 'none',
      subtasks: [],
      goalId: cached.goalId,
      goalContribution: contribution,
      completed: false,
      createdAt: new Date().toISOString()
    });
    save('todos');
    emit('db:changed');

    el.disabled = true;
    el.textContent = '✓ 已采纳';
    el.classList.remove('btn-primary');
    el.classList.add('btn-ghost');
    if (row) row.classList.add('accepted');
    toast('已添加待办', 'success');
  },

  'goal-ai-accept-all': () => {
    const cached = State._aiGoalDecompose;
    if (!cached) return;
    let ok = 0;
    cached.todos.forEach((t, i) => {
      const row = document.querySelector(`[data-decompose-idx="${i}"]`);
      if (!row || row.classList.contains('accepted')) return;
      const titleEl = row.querySelector('.decompose-title');
      const dateEl = row.querySelector('.decompose-date');
      const priEl = row.querySelector('.decompose-priority');
      const repeatEl = row.querySelector('.decompose-repeat');
      const contribEl = row.querySelector('.decompose-contrib');

      const title = titleEl ? titleEl.value.trim() : t.title;
      if (!title) return;
      const repeat = repeatEl ? repeatEl.value : (t.repeat || 'none');

      DB.todos.push({
        id: uid(),
        user_id: State.user.id,
        title,
        date: (dateEl ? dateEl.value : t.date) || today(),
        time: '09:00',
        priority: (priEl ? priEl.value : t.priority) || 'medium',
        repeat: ['none', 'daily', 'weekly', 'monthly'].includes(repeat) ? repeat : 'none',
        subtasks: [],
        goalId: cached.goalId,
        goalContribution: (contribEl ? (parseFloat(contribEl.value) || 0) : (t.contribution || 0)),
        completed: false,
        createdAt: new Date().toISOString()
      });
      ok++;
    });
    save('todos');
    emit('db:changed');
    hideModal();
    State._aiGoalDecompose = null;
    toast(`已采纳 ${ok} 条待办`, ok ? 'success' : 'warning');
    rerender();
  }
};

/* ⭐ 拆解结果：加 repeat 下拉 */
function renderDecomposeResult() {
  const cached = State._aiGoalDecompose;
  if (!cached) return;
  const g = cached.goal;
  const isQuant = g.type === 'quant';
  const unit = g.unit || '';

  showModal('goalDecompose', `
    <h3 style="font-size:16px;margin-bottom:10px;font-weight:800">🤖 AI 拆解建议</h3>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px">
      目标：<b style="color:var(--text)">${esc(g.title)}</b>
      ${isQuant ? ` · 单位：${esc(unit)}` : ' · 手动型目标'}
    </div>
    <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:10px;line-height:1.6">
      💡 每条都可以直接编辑标题、日期、优先级、重复方式${isQuant ? '和贡献值' : ''}，确认无误后采纳
    </div>
    <div class="decompose-list">
      ${cached.todos.map((t, i) => `
        <div class="decompose-item" data-decompose-idx="${i}">
          <div class="decompose-row">
            <input type="text" class="input decompose-title" value="${esc(t.title)}" placeholder="待办标题">
          </div>
          <div class="decompose-row decompose-row-2">
            <div class="decompose-field">
              <label>📅 日期</label>
              <input type="date" class="input decompose-date" value="${t.date}">
            </div>
            <div class="decompose-field">
              <label>⚡ 优先级</label>
              <select class="input decompose-priority">
                <option value="high"${t.priority === 'high' ? ' selected' : ''}>🔴 高</option>
                <option value="medium"${t.priority === 'medium' ? ' selected' : ''}>🟡 中</option>
                <option value="low"${t.priority === 'low' ? ' selected' : ''}>🔵 低</option>
              </select>
            </div>
            <div class="decompose-field">
              <label>🔁 重复</label>
              <select class="input decompose-repeat">
                <option value="none"${(t.repeat || 'none') === 'none' ? ' selected' : ''}>不重复</option>
                <option value="daily"${t.repeat === 'daily' ? ' selected' : ''}>每天</option>
                <option value="weekly"${t.repeat === 'weekly' ? ' selected' : ''}>每周</option>
                <option value="monthly"${t.repeat === 'monthly' ? ' selected' : ''}>每月</option>
              </select>
            </div>
            ${isQuant ? `
            <div class="decompose-field">
              <label>📈 贡献(${esc(unit)})</label>
              <input type="number" class="input decompose-contrib" value="${t.contribution || ''}" step="0.1" placeholder="0">
            </div>
            ` : ''}
          </div>
          <div class="decompose-actions">
            <button class="btn btn-xs btn-primary" data-action="goal-ai-accept-todo" data-idx="${i}" type="button">✓ 采纳</button>
          </div>
        </div>
      `).join('')}
    </div>
    <div style="display:flex;gap:10px;justify-content:space-between;margin-top:16px;flex-wrap:wrap">
      <button class="btn btn-sm btn-ghost" data-action="modal-close" type="button">关闭</button>
      <button class="btn btn-sm btn-primary" data-action="goal-ai-accept-all" type="button">✓ 全部采纳</button>
    </div>
  `, 'lg');
}

function openModal(edit) {
  const isEdit = !!edit;
  const type = edit ? edit.type : 'manual';
  showModal('goalAdd', `
    <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">${isEdit ? '✏️ 编辑目标' : '🎯 添加目标'}</h3>
    <input type="hidden" id="gId" value="${edit ? esc(edit.id) : ''}">
    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">目标名称</label>
      <input type="text" class="input" id="gTitle" value="${edit ? esc(edit.title) : ''}" placeholder="例如：通过期末考试 / 跑步 100km">
    </div>
    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">类型</label>
      <select class="input" id="gType">
        <option value="manual"${type === 'manual' ? ' selected' : ''}>手动型（自己拖进度）</option>
        <option value="quant"${type === 'quant' ? ' selected' : ''}>量化型（累积记录自动算）</option>
      </select>
    </div>
    <div id="gManualRow" class="${type === 'quant' ? 'hidden' : ''}" style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">当前进度（%）</label>
      <input type="number" class="input" id="gProgress" min="0" max="100" value="${edit && edit.type === 'manual' ? (edit.progress || 0) : 0}" style="max-width:120px">
    </div>
    <div id="gQuantRow" class="${type === 'manual' ? 'hidden' : ''}">
      <div style="display:flex;gap:10px;margin-bottom:12px">
        <div style="flex:1">
          <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">目标总量</label>
          <input type="number" class="input" id="gTotal" step="0.1" value="${edit && edit.type === 'quant' ? (edit.target_total || '') : ''}" placeholder="100">
        </div>
        <div style="flex:1">
          <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">单位</label>
          <input type="text" class="input" id="gUnit" value="${edit && edit.type === 'quant' ? esc(edit.unit || '') : ''}" placeholder="km / 本 / 次">
        </div>
      </div>
    </div>
    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">截止日期（可选）</label>
      <input type="date" class="input" id="gDeadline" value="${edit && edit.deadline ? edit.deadline : ''}" style="max-width:180px">
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
      <button class="btn btn-sm" data-action="modal-close" data-modal="goalAdd" type="button">取消</button>
      <button class="btn btn-sm btn-primary" data-action="goal-save" type="button">${isEdit ? '保存' : '添加'}</button>
    </div>
  `);
  setTimeout(() => {
    const sel = document.getElementById('gType');
    if (sel) {
      sel.addEventListener('change', () => {
        document.getElementById('gManualRow').classList.toggle('hidden', sel.value !== 'manual');
        document.getElementById('gQuantRow').classList.toggle('hidden', sel.value !== 'quant');
      });
    }
  }, 50);
}

function syncDone(g) {
  const now = isDone(g);
  if (now && !g.completed) { g.completed = true; g.completedAt = new Date().toISOString(); }
  else if (!now && g.completed) { g.completed = false; g.completedAt = null; }
}

document.addEventListener('change', e => {
  if (e.target.classList && e.target.classList.contains('goal-progress-edit')) {
    const g = DB.goals.find(x => x.id === e.target.dataset.id);
    if (g && g.type === 'manual') {
      g.progress = clamp(parseInt(e.target.value) || 0, 0, 100);
      syncDone(g);
      save('goals');
      emit('db:changed');
      rerender();
    }
  }
});