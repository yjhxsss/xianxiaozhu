import { DB, State, save, snapshotDelete, undo } from '../../core/db.js';
import { esc, today, uid, addDays, fmtD } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';

export function getTodayTodos() {
  const t = today();
  return DB.todos.filter(x => x.user_id === State.user.id && x.date === t).sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (a.time || '99:99').localeCompare(b.time || '99:99');
  });
}

export function getDoneCount() {
  const t = today();
  return DB.todos.filter(x => x.user_id === State.user.id && x.date === t && x.completed).length;
}

function maybeRerenderOtherTabs() {
  if (State.currentTab !== 'diary') {
    setTimeout(() => {
      try { rerender(); } catch (e) { console.warn(e); }
    }, 60);
  }
}

/* ================================================================
 * ⭐ 通用：渲染"可展开的待办列表"
 * 主页和日历页共用，保证行为完全一致
 * ================================================================ */
export function renderTodoListExpandable(todos, opts = {}) {
  const expandedKey = opts.expandedKey || 'todosExpanded';
  const toggleAction = opts.toggleAction || 'toggle-todos-expand';
  const limit = opts.limit || 6;
  const emptyHtml = opts.emptyHtml || '<div class="done-empty">暂无待办</div>';

  if (!todos || !todos.length) return emptyHtml;

  const expanded = !!State[expandedKey];
  const shown = expanded ? todos : todos.slice(0, limit);

  let html = `<div class="todo-list">${shown.map(renderTodoRow).join('')}</div>`;

  if (todos.length > limit) {
    html += `<button class="btn btn-xs btn-ghost expand-btn" data-action="${toggleAction}" type="button">
      ${expanded ? '收起 ▲' : `展开全部 ${todos.length} 条 ▼`}
    </button>`;
  }
  return html;
}

/* 主页用 */
export function renderPanel(todos) {
  const cnt = todos.length;
  return `
    <div class="panel">
      <div class="panel-title">
        <span class="title-icon">📋</span>今日待办
        <span style="margin-left:auto;display:flex;gap:6px;align-items:center">
          ${cnt > 6 ? `<span style="font-size:11px;color:var(--text-muted);font-weight:700">${cnt} 条</span>` : ''}
          <button class="btn btn-xs btn-primary" data-action="todo-add" type="button">+</button>
        </span>
      </div>
      <div id="todayTodosList">${renderTodosHTML(todos)}</div>
    </div>`;
}

/* 主页用 */
export function renderTodosHTML(todos) {
  return renderTodoListExpandable(todos, {
    expandedKey: 'todosExpanded',
    toggleAction: 'toggle-todos-expand',
    emptyHtml: '<div class="done-empty">今日暂无待办 🎈</div>'
  });
}

function repeatBadge(repeat) {
  if (!repeat || repeat === 'none') return '';
  const map = {
    daily:   { icon: '🔁', text: '每天' },
    weekly:  { icon: '🔁', text: '每周' },
    monthly: { icon: '🔁', text: '每月' }
  };
  const r = map[repeat];
  if (!r) return '';
  return `<span class="todo-repeat-tag" title="重复：${r.text}">${r.icon} ${r.text}</span>`;
}

export function renderTodoRow(t) {
  const subs = t.subtasks || [];
  const pr = t.priority || 'medium';

  let goalTag = '';
  if (t.goalId) {
    const g = DB.goals.find(x => x.id === t.goalId);
    if (g) {
      const contrib = t.goalContribution > 0 && g.type === 'quant'
        ? `+${t.goalContribution}${g.unit || ''}`
        : '';
      goalTag = `<span class="todo-goal-tag" title="关联目标：${esc(g.title)}">🎯 ${esc(g.title.slice(0, 6))}${contrib ? ' ' + esc(contrib) : ''}</span>`;
    }
  }

  return `
    <div class="todo-item${t.completed ? ' completed' : ''}" data-id="${t.id}">
      <div class="todo-main">
        <span class="todo-priority ${pr}"></span>
        <button class="todo-check${t.completed ? ' checked' : ''}" data-action="todo-toggle" data-id="${t.id}" type="button">${t.completed ? '✓' : ''}</button>
        <span class="todo-title">${esc(t.title)}</span>
        ${repeatBadge(t.repeat)}
        ${goalTag}
        ${subs.length ? `<span class="todo-badge">${subs.filter(s => s.done).length}/${subs.length}</span>` : ''}
        <span style="font-size:11px;color:var(--text-muted);font-weight:600">${t.time || '全天'}</span>
        <button class="btn btn-xs btn-ghost" data-action="todo-edit" data-id="${t.id}" type="button">✎</button>
        <button class="btn btn-xs btn-danger" data-action="todo-del" data-id="${t.id}" type="button">✕</button>
      </div>
      ${subs.length ? `
        <div class="subtasks">
          ${subs.map((s, i) => `
            <div class="subtask${s.done ? ' checked-text' : ''}">
              <button class="subtask-check${s.done ? ' checked' : ''}" data-action="subtask-toggle" data-id="${t.id}" data-idx="${i}" type="button">${s.done ? '✓' : ''}</button>
              <span>${esc(s.title)}</span>
            </div>
          `).join('')}
        </div>` : ''}
    </div>`;
}

export function renderDonePanel(count) {
  return `
    <div class="panel">
      <div class="panel-title">
        <span class="title-icon">✅</span>今日完成
        <span class="more" id="todayDoneCount">${count}</span>
      </div>
      <div id="todayDoneList"></div>
    </div>`;
}

export function renderDoneList() {
  const el = document.getElementById('todayDoneList');
  if (!el) return;

  const t = today();
  const u = State.user.id;
  const items = [];

  DB.todos.filter(x => x.user_id === u && x.date === t && x.completed).forEach(x => {
    items.push({
      type: 'todo',
      icon: '✅',
      title: x.title,
      ts: x.completedAt || x.createdAt || (t + 'T23:59:00'),
      meta: `完成于 ${x.time || '全天'}`
    });
  });

  DB.focusSessions.filter(f => f.user_id === u && f.date === t).forEach(f => {
    items.push({
      type: 'focus',
      icon: f.mode === 'custom' ? '⏲️' : '🍅',
      title: f.note || '专注时段',
      ts: f.completedAt,
      dur: `${f.duration_minutes} 分钟`
    });
  });

  DB.habitLogs.filter(l => l.user_id === u && l.date === t).forEach(l => {
    const h = DB.habits.find(x => x.id === l.habit_id);
    items.push({
      type: 'habit',
      icon: '🔥',
      title: h ? h.name : '习惯打卡',
      ts: l.createdAt
    });
  });

  items.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const cnt = document.getElementById('todayDoneCount');
  if (cnt) cnt.textContent = items.length;

  if (!items.length) {
    el.innerHTML = '<div class="done-empty" style="padding:14px">今天还没有完成的事情<br><span style="font-size:11px">完成待办/专注/习惯打卡后会出现在这里</span></div>';
    return;
  }

  const expanded = !!State.doneExpanded;
  const shown = expanded ? items : items.slice(0, 6);

  let html = `<div class="done-list">${shown.map(it => {
    const cls = it.type === 'focus' ? 'focus' : it.type === 'habit' ? 'habit' : '';
    const time = it.ts && it.ts.length > 10 ? new Date(it.ts).toTimeString().slice(0, 5) : '';
    return `<div class="done-item">
      <div class="done-icon ${cls}">${it.icon}</div>
      <div class="done-body">
        <div class="done-title ${it.type === 'todo' ? 'done' : ''}">${esc(it.title)}</div>
        <div class="done-meta">
          ${time ? `<span>🕐 ${time}</span>` : ''}
          ${it.dur ? `<span class="dur">${it.dur}</span>` : ''}
          ${it.meta && it.type === 'todo' ? `<span>${esc(it.meta)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;

  if (items.length > 6) {
    html += `<button class="btn btn-xs btn-ghost expand-btn" data-action="toggle-done-expand" type="button">
      ${expanded ? '收起 ▲' : `展开全部 ${items.length} 条 ▼`}
    </button>`;
  }

  el.innerHTML = html;
}

function refreshTodoList() {
  const el = document.getElementById('todayTodosList');
  if (el) el.innerHTML = renderTodosHTML(getTodayTodos());
}

/* ============ 目标联动 ============ */
function applyTodoContribution(todo) {
  const g = DB.goals.find(x => x.id === todo.goalId);
  if (!g || g.type !== 'quant') return false;
  const contribution = parseFloat(todo.goalContribution);
  if (!contribution || contribution <= 0) return false;

  if (!g.records) g.records = [];
  g.records = g.records.filter(r => !(r.source === 'todo' && r.todoId === todo.id));
  g.records.push({
    id: uid(),
    value: contribution,
    note: `来自待办：${todo.title.slice(0, 20)}`,
    date: today(),
    createdAt: new Date().toISOString(),
    source: 'todo',
    todoId: todo.id
  });
  syncGoalDone(g);
  return true;
}

function undoApplyTodoContribution(todo) {
  const g = DB.goals.find(x => x.id === todo.goalId);
  if (!g || !g.records) return false;
  const before = g.records.length;
  g.records = g.records.filter(r => !(r.source === 'todo' && r.todoId === todo.id));
  if (g.records.length !== before) {
    syncGoalDone(g);
    return true;
  }
  return false;
}

function applyManualProgress(todo, delta) {
  const g = DB.goals.find(x => x.id === todo.goalId);
  if (!g || g.type !== 'manual') return false;
  const d = parseFloat(delta);
  if (isNaN(d) || d === 0) return false;
  const before = clamp(parseInt(g.progress) || 0, 0, 100);
  g.progress = clamp(before + d, 0, 100);
  syncGoalDone(g);
  return true;
}

function syncGoalDone(g) {
  const isDoneNow = (() => {
    if (g.type === 'quant') {
      const total = (g.records || []).reduce((s, r) => s + (parseFloat(r.value) || 0), 0);
      const target = parseFloat(g.target_total) || 0;
      return target > 0 && total / target >= 1;
    }
    return (parseInt(g.progress) || 0) >= 100;
  })();
  if (isDoneNow && !g.completed) { g.completed = true; g.completedAt = new Date().toISOString(); }
  else if (!isDoneNow && g.completed) { g.completed = false; g.completedAt = null; }
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function nextRepeatDate(dateStr, repeat) {
  const d = new Date(dateStr + 'T00:00:00');
  if (repeat === 'daily') d.setDate(d.getDate() + 1);
  else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
  else if (repeat === 'monthly') d.setMonth(d.getMonth() + 1);
  return fmtD(d);
}

function spawnNextRepeat(todo) {
  if (!todo.repeat || todo.repeat === 'none') return false;
  const nextDate = nextRepeatDate(todo.date, todo.repeat);

  const exists = DB.todos.some(x =>
    x.user_id === todo.user_id &&
    x.title === todo.title &&
    x.date === nextDate &&
    x.repeat === todo.repeat
  );
  if (exists) return false;

  DB.todos.push({
    id: uid(),
    user_id: todo.user_id,
    title: todo.title,
    date: nextDate,
    time: todo.time || '09:00',
    priority: todo.priority || 'medium',
    repeat: todo.repeat,
    subtasks: (todo.subtasks || []).map(s => ({ title: s.title, done: false })),
    goalId: todo.goalId || null,
    goalContribution: todo.goalContribution || 0,
    completed: false,
    createdAt: new Date().toISOString(),
    _fromRepeat: todo.id
  });
  return true;
}

function showManualGoalDialog(todo, goal) {
  showModal('todoGoalDialog', `
    <h3 style="font-size:16px;margin-bottom:14px;font-weight:800">✅ 完成待办</h3>
    <div style="font-size:13px;color:var(--text-sec);margin-bottom:16px;line-height:1.7">
      待办：<b style="color:var(--text)">${esc(todo.title)}</b><br>
      关联目标：<b style="color:var(--accent)">${esc(goal.title)}</b>
      <span style="color:var(--text-muted)">（当前进度 ${goal.progress || 0}%）</span>
    </div>
    <div style="background:var(--accent-soft);border:1px solid var(--accent);border-radius:10px;padding:14px 16px;margin-bottom:16px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:8px;font-weight:700">
        🎯 这条待办完成后，给目标增加多少进度？
      </label>
      <div style="display:flex;align-items:center;gap:8px">
        <input type="number" class="input" id="todoGoalDelta" value="5" min="0" max="100" step="1" style="max-width:100px;text-align:center;font-family:var(--mono);font-weight:800">
        <span style="font-size:14px;font-weight:700;color:var(--text-sec)">%</span>
        <span style="margin-left:auto;font-size:11.5px;color:var(--text-muted)">0 = 不增加进度</span>
      </div>
      <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
        ${[1, 5, 10, 20].map(n => `<button class="btn btn-xs btn-ghost" data-action="todo-goal-quick" data-delta="${n}" type="button">+${n}%</button>`).join('')}
      </div>
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
      <button class="btn btn-sm btn-ghost" data-action="modal-close" type="button">取消</button>
      <button class="btn btn-sm" data-action="todo-goal-skip" data-id="${todo.id}" type="button">完成但不影响目标</button>
      <button class="btn btn-sm btn-primary" data-action="todo-goal-confirm" data-id="${todo.id}" type="button">✓ 确认完成</button>
    </div>
  `);
  setTimeout(() => {
    const el = document.getElementById('todoGoalDelta');
    if (el) { el.focus(); el.select(); }
  }, 80);
}

function completeTodo(todo) {
  todo.completed = true;
  todo.completedAt = new Date().toISOString();
}

export function toggleTodo(id) {
  const t = DB.todos.find(x => x.id === id);
  if (!t) return { status: 'not-found' };

  const willComplete = !t.completed;

  if (!willComplete) {
    t.completed = false;
    t.completedAt = null;

    let undoneGoal = false;
    if (t.goalId) {
      if (undoApplyTodoContribution(t)) undoneGoal = true;
    }

    const spawnedNext = DB.todos.find(x => x._fromRepeat === t.id);
    let removedSpawn = false;
    if (spawnedNext && !spawnedNext.completed) {
      DB.todos = DB.todos.filter(x => x.id !== spawnedNext.id);
      removedSpawn = true;
    }

    save('todos', 'goals');
    emit('db:changed');
    return { status: 'uncompleted', undoneGoal, removedSpawn, todo: t };
  }

  const g = t.goalId ? DB.goals.find(x => x.id === t.goalId) : null;

  const doComplete = (resultExtra = {}) => {
    completeTodo(t);
    const spawned = spawnNextRepeat(t);
    save('todos', 'goals');
    emit('db:changed');
    return { status: 'done', todo: t, spawnedNext: spawned, ...resultExtra };
  };

  if (!g || g.completed) return doComplete();

  if (g.type === 'quant' && parseFloat(t.goalContribution) > 0) {
    completeTodo(t);
    const ok = applyTodoContribution(t);
    const spawned = spawnNextRepeat(t);
    save('todos', 'goals');
    emit('db:changed');
    return {
      status: 'done',
      todo: t,
      spawnedNext: spawned,
      toast: ok ? `✅ 完成！目标「${g.title.slice(0, 8)}」+${t.goalContribution}${g.unit || ''}` : null
    };
  }

  if (g.type === 'quant') {
    return doComplete({ toast: '已完成（这条待办没有设置目标贡献值）', toastType: 'info' });
  }

  if (g.type === 'manual') {
    return { status: 'need-dialog', todo: t, goal: g };
  }

  return doComplete();
}

export const actions = {
  'todo-add': () => showModalFor(),

  'todo-edit': (el) => {
    const t = DB.todos.find(x => x.id === el.dataset.id);
    if (t) showModalFor(t);
  },

  'todo-save': () => {
    const idEl = document.getElementById('tdId');
    const id = idEl ? idEl.value : '';
    const title = document.getElementById('tdTitle').value.trim();
    const date = document.getElementById('tdDate').value;
    const time = document.getElementById('tdTime').value || '09:00';
    const priority = document.getElementById('tdPriority').value;
    const repeatEl = document.getElementById('tdRepeat');
    const repeat = repeatEl ? (repeatEl.value || 'none') : 'none';

    const goalIdEl = document.getElementById('tdGoal');
    const goalId = goalIdEl && goalIdEl.value ? goalIdEl.value : null;
    const contribEl = document.getElementById('tdGoalContribution');
    const goalContribution = contribEl ? (parseFloat(contribEl.value) || 0) : 0;

    if (!title) { toast('请输入标题', 'warning'); return; }

    if (id) {
      const t = DB.todos.find(x => x.id === id);
      if (t) Object.assign(t, {
        title, date, time, priority, repeat,
        goalId: goalId || null,
        goalContribution: goalId ? goalContribution : 0
      });
    } else {
      DB.todos.push({
        id: uid(),
        user_id: State.user.id,
        title, date, time, priority, repeat,
        subtasks: [],
        goalId: goalId || null,
        goalContribution: goalId ? goalContribution : 0,
        completed: false,
        createdAt: new Date().toISOString()
      });
    }
    save('todos');
    emit('db:changed');
    hideModal();
    toast('已保存', 'success');
    refreshTodoList();
    setTimeout(renderDoneList, 50);
    maybeRerenderOtherTabs();
  },

  'todo-toggle': (el) => {
    const result = toggleTodo(el.dataset.id);
    if (result.status === 'not-found') return;

    if (result.status === 'need-dialog') {
      showManualGoalDialog(result.todo, result.goal);
      return;
    }

    if (result.status === 'uncompleted') {
      refreshTodoList();
      setTimeout(renderDoneList, 50);
      if (result.undoneGoal) toast('已取消完成，目标进度同步回退', 'info');
      if (result.removedSpawn) toast('已删除重复生成的下一条', 'info');
      maybeRerenderOtherTabs();
      return;
    }

    if (result.status === 'done') {
      refreshTodoList();
      setTimeout(renderDoneList, 50);
      if (result.toast) toast(result.toast, result.toastType || 'success', { duration: 3000 });
      if (result.spawnedNext) {
        const spawn = DB.todos.find(x => x._fromRepeat === result.todo.id);
        if (spawn) toast(`🔁 已创建下一条：${spawn.date}`, 'success', { duration: 3000 });
      }
      maybeRerenderOtherTabs();
      return;
    }
  },

  'todo-goal-confirm': (el) => {
    const id = el.dataset.id;
    const t = DB.todos.find(x => x.id === id);
    if (!t) { hideModal(); return; }
    const g = DB.goals.find(x => x.id === t.goalId);
    if (!g) { hideModal(); return; }

    const input = document.getElementById('todoGoalDelta');
    const delta = parseFloat(input ? input.value : 0) || 0;

    completeTodo(t);
    let goalChanged = false;
    if (delta > 0) goalChanged = applyManualProgress(t, delta);

    const spawned = spawnNextRepeat(t);

    save('todos', 'goals');
    emit('db:changed');
    hideModal();
    refreshTodoList();
    setTimeout(renderDoneList, 50);
    if (goalChanged) {
      toast(`✅ 完成！「${g.title.slice(0, 8)}」进度 +${delta}%`, 'success');
    } else {
      toast('已完成', 'success');
    }
    if (spawned) {
      const spawn = DB.todos.find(x => x._fromRepeat === t.id);
      if (spawn) toast(`🔁 已创建下一条：${spawn.date}`, 'success', { duration: 3000 });
    }
    maybeRerenderOtherTabs();
  },

  'todo-goal-skip': (el) => {
    const id = el.dataset.id;
    const t = DB.todos.find(x => x.id === id);
    if (!t) { hideModal(); return; }
    completeTodo(t);
    const spawned = spawnNextRepeat(t);
    save('todos');
    emit('db:changed');
    hideModal();
    refreshTodoList();
    setTimeout(renderDoneList, 50);
    toast('已完成（未影响目标进度）', 'success');
    if (spawned) {
      const spawn = DB.todos.find(x => x._fromRepeat === t.id);
      if (spawn) toast(`🔁 已创建下一条：${spawn.date}`, 'success', { duration: 3000 });
    }
    maybeRerenderOtherTabs();
  },

  'todo-goal-quick': (el) => {
    const input = document.getElementById('todoGoalDelta');
    if (input) {
      input.value = el.dataset.delta;
      input.focus();
      input.select();
    }
  },

  'todo-del': (el) => {
    const id = el.dataset.id;
    const t = DB.todos.find(x => x.id === id && x.user_id === State.user.id);
    if (!t) return;
    if (!confirm('删除这条待办？')) return;

    const spawnedNext = DB.todos.find(x => x._fromRepeat === id);
    const removed = snapshotDelete('todos', id);
    if (!removed) return;

    if (spawnedNext && !spawnedNext.completed) {
      DB.todos = DB.todos.filter(x => x.id !== spawnedNext.id);
    }

    save('todos');
    emit('db:changed');
    refreshTodoList();
    setTimeout(renderDoneList, 50);
    maybeRerenderOtherTabs();

    toast('已删除待办', 'success', {
      actions: [{
        label: '撤销',
        onClick: () => {
          if (undo()) {
            emit('db:changed');
            toast('已恢复待办', 'success');
            refreshTodoList();
            setTimeout(renderDoneList, 50);
            maybeRerenderOtherTabs();
          }
        }
      }]
    });
  },

  'subtask-toggle': (el) => {
    const t = DB.todos.find(x => x.id === el.dataset.id);
    const idx = parseInt(el.dataset.idx);
    if (!t || !t.subtasks || !t.subtasks[idx]) return;

    t.subtasks[idx].done = !t.subtasks[idx].done;
    save('todos');
    emit('db:changed');

    const done = t.subtasks[idx].done;
    el.classList.toggle('checked', done);
    el.textContent = done ? '✓' : '';

    const parent = el.closest('.subtask');
    if (parent) parent.classList.toggle('checked-text', done);

    const parentTodo = el.closest('.todo-item');
    if (parentTodo) {
      const badge = parentTodo.querySelector('.todo-badge');
      if (badge) {
        badge.textContent = `${t.subtasks.filter(s => s.done).length}/${t.subtasks.length}`;
      }
    }
  },

  /* ⭐ 主页展开 */
  'toggle-todos-expand': () => {
    State.todosExpanded = !State.todosExpanded;
    refreshTodoList();
  },

  'toggle-done-expand': () => {
    State.doneExpanded = !State.doneExpanded;
    renderDoneList();
  }
};

document.addEventListener('change', e => {
  if (!e.target || e.target.id !== 'tdGoal') return;
  const goalId = e.target.value || '';
  const wrap = document.getElementById('tdGoalContribWrap');
  const manualHint = document.getElementById('tdGoalManualHint');
  const unitEl = document.getElementById('tdGoalContribUnit');
  const contribInput = document.getElementById('tdGoalContribution');
  if (!wrap) return;
  if (!goalId) {
    wrap.classList.add('hidden');
    if (manualHint) manualHint.classList.add('hidden');
    return;
  }
  const g = DB.goals.find(x => x.id === goalId);
  if (g && g.type === 'quant') {
    wrap.classList.remove('hidden');
    if (manualHint) manualHint.classList.add('hidden');
    if (unitEl) unitEl.textContent = g.unit || '';
  } else {
    wrap.classList.add('hidden');
    if (manualHint) manualHint.classList.remove('hidden');
    if (contribInput) contribInput.value = '';
  }
});

function showModalFor(edit) {
  const t = edit || {};
  const isEdit = !!edit;
  const availableGoals = DB.goals.filter(g => g.user_id === State.user.id && !g.completed);
  const currentGoalId = edit && edit.goalId ? edit.goalId : '';
  const currentGoal = currentGoalId ? DB.goals.find(g => g.id === currentGoalId) : null;
  const showContribRow = !!(currentGoal && currentGoal.type === 'quant');
  const showManualHint = !!(currentGoal && currentGoal.type === 'manual');
  const currentContrib = edit && edit.goalContribution ? edit.goalContribution : '';
  const currentUnit = currentGoal ? (currentGoal.unit || '') : '';
  const currentRepeat = (edit && edit.repeat) ? edit.repeat : 'none';

  const goalOptions = availableGoals.map(g => {
    const typeTag = g.type === 'quant'
      ? ` [量化 ${g.target_total || '?'}${g.unit || ''}]`
      : ' [手动型]';
    return `<option value="${g.id}"${currentGoalId === g.id ? ' selected' : ''}>${esc(g.title)}${typeTag}</option>`;
  }).join('');

  showModal('todoAdd', `
    <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">${isEdit ? '编辑待办' : '添加待办'}</h3>
    <input type="hidden" id="tdId" value="${edit ? esc(t.id) : ''}">

    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">标题</label>
      <input type="text" class="input" id="tdTitle" value="${edit ? esc(t.title) : ''}">
    </div>

    <div style="display:flex;gap:10px;margin-bottom:12px">
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">日期</label>
        <input type="date" class="input" id="tdDate" value="${edit && t.date ? t.date : today()}">
      </div>
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">时间</label>
        <input type="time" class="input" id="tdTime" value="${edit && t.time ? t.time : '09:00'}">
      </div>
    </div>

    <div style="display:flex;gap:10px;margin-bottom:12px">
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">优先级</label>
        <select class="input" id="tdPriority">
          <option value="low"${edit && t.priority === 'low' ? ' selected' : ''}>🔵 低</option>
          <option value="medium"${!edit || t.priority === 'medium' ? ' selected' : ''}>🟡 中</option>
          <option value="high"${edit && t.priority === 'high' ? ' selected' : ''}>🔴 高</option>
        </select>
      </div>
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">🔁 重复方式</label>
        <select class="input" id="tdRepeat">
          <option value="none"${currentRepeat === 'none' ? ' selected' : ''}>不重复</option>
          <option value="daily"${currentRepeat === 'daily' ? ' selected' : ''}>每天</option>
          <option value="weekly"${currentRepeat === 'weekly' ? ' selected' : ''}>每周</option>
          <option value="monthly"${currentRepeat === 'monthly' ? ' selected' : ''}>每月</option>
        </select>
      </div>
    </div>

    <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:12px;line-height:1.6;padding:8px 12px;background:var(--bg-input);border-radius:8px">
      💡 设置了重复方式后：完成后会自动创建下一条；取消完成/删除时会连带删掉下一条。
    </div>

    ${availableGoals.length ? `
      <div style="margin-bottom:12px;padding:12px 14px;background:var(--bg-input);border-radius:10px;border:1px solid var(--border)">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px;font-weight:700">🎯 关联目标（可选）</label>
        <select class="input" id="tdGoal">
          <option value="">不关联</option>
          ${goalOptions}
        </select>

        <div id="tdGoalContribWrap" class="${showContribRow ? '' : 'hidden'}" style="margin-top:10px">
          <label style="font-size:12px;color:var(--text-sec);display:block;margin-bottom:6px">
            完成后给目标增加多少 <span id="tdGoalContribUnit" style="font-weight:800;color:var(--accent)">${esc(currentUnit)}</span>？
          </label>
          <input type="number" class="input" id="tdGoalContribution" step="0.1" value="${currentContrib}" placeholder="0" style="max-width:150px">
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.5">
            完成后会自动加到目标进度里；取消完成会自动回退。
          </div>
        </div>

        <div id="tdGoalManualHint" class="${showManualHint ? '' : 'hidden'}" style="font-size:11.5px;color:var(--text-muted);margin-top:8px;line-height:1.6">
          💡 手动型目标不需要填贡献值 —— 完成这条待办时会弹窗让你决定加多少百分比。
        </div>
      </div>
    ` : ''}

    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
      <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
      <button class="btn btn-sm btn-primary" data-action="todo-save" type="button">${isEdit ? '保存' : '添加'}</button>
    </div>
  `);
}
// END OF FILE