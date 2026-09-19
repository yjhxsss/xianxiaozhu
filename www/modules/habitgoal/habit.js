import { DB, State, save, snapshotDelete, undo } from '../../core/db.js';
import { esc, today, uid, fmtD, addDays, weekStart } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { forceReload } from '../../ui/shell.js';

export function getHabits() {
  return DB.habits.filter(h => h.user_id === State.user.id);
}

export function streak(habitId, endDate) {
  const u = State.user.id;
  const dates = new Set();
  for (const l of DB.habitLogs) {
    if (l.user_id === u && l.habit_id === habitId) dates.add(l.date);
  }
  let s = 0;
  const d = new Date(endDate + 'T00:00:00');
  while (dates.has(fmtD(d))) {
    s++;
    d.setDate(d.getDate() - 1);
  }
  return s;
}

export function renderPanel(habits) {
  const groups = {};
  habits.forEach(h => {
    const g = h.group || '未分组';
    if (!groups[g]) groups[g] = [];
    groups[g].push(h);
  });

  return `
    <div class="panel">
      <div class="panel-title">
        <span class="title-icon">🔥</span>习惯打卡
        <button class="btn btn-xs btn-primary" data-action="habit-add" type="button" style="margin-left:auto">+ 添加</button>
      </div>
      <div id="habitListBody">
        ${habits.length
          ? Object.keys(groups).map(g => `
            <div class="habit-group">
              <div class="habit-group-title">${esc(g)}（${groups[g].length}）</div>
              ${groups[g].map(renderHabitItem).join('')}
            </div>
          `).join('')
          : '<div class="done-empty">暂无习惯，点右上角添加 🌱</div>'}
      </div>
    </div>`;
}

function renderHabitItem(h) {
  const u = State.user.id;
  const t = today();
  const logged = DB.habitLogs.find(l => l.user_id === u && l.habit_id === h.id && l.date === t);
  const s = streak(h.id, t);
  const ws = weekStart(new Date());
  const wl = DB.habitLogs.filter(l =>
    l.user_id === u && l.habit_id === h.id &&
    l.date >= fmtD(ws) && l.date <= fmtD(addDays(ws, 6))
  ).length;
  const goal = h.weekly_goal || 7;
  const badge = s >= 30 ? '🏆' : s >= 14 ? '🥇' : s >= 7 ? '🥈' : s >= 3 ? '🥉' : '';

  return `
    <div class="habit-item" data-id="${h.id}">
      <button class="habit-check${logged ? ' checked' : ''}" data-action="habit-toggle" data-id="${h.id}" type="button">${logged ? '✓' : ''}</button>
      <div style="flex:1;min-width:0">
        <div class="habit-name">${esc(h.name)}${badge ? `<span class="habit-badge">${badge}</span>` : ''}</div>
        <div class="habit-progress">本周 <span class="habit-week-count">${wl}</span>/${goal}</div>
      </div>
      <span class="habit-streak">🔥<span class="habit-streak-num">${s}</span></span>
      <button class="btn btn-xs btn-ghost" data-action="habit-makeup" data-id="${h.id}" type="button">补</button>
      <button class="btn btn-xs btn-danger" data-action="habit-del" data-id="${h.id}" type="button">删</button>
    </div>`;
}

function heatmapCellsHTML() {
  const u = State.user.id;
  const total = DB.habits.filter(h => h.user_id === u).length;
  const byDate = Object.create(null);
  for (const l of DB.habitLogs) {
    if (l.user_id === u) byDate[l.date] = (byDate[l.date] || 0) + 1;
  }
  let cells = '';
  for (let i = 29; i >= 0; i--) {
    const ds = fmtD(addDays(new Date(), -i));
    const logs = byDate[ds] || 0;
    const level = total > 0 ? Math.min(3, Math.ceil((logs / total) * 3)) : 0;
    cells += `<div class="heatmap-cell${level > 0 ? ' l' + level : ''}" title="${ds} · ${logs}/${total}"></div>`;
  }
  return cells;
}

export function renderHeatmap() {
  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">🗓️</span>近 30 天热力图</div>
      <div class="heatmap" id="heatmapGrid">${heatmapCellsHTML()}</div>
    </div>`;
}

function refreshHabitItem(habitId) {
  const u = State.user.id;
  const t = today();
  const h = DB.habits.find(x => x.id === habitId);
  if (!h) return;

  const item = document.querySelector(`.habit-item[data-id="${habitId}"]`);
  if (!item) return;

  const logged = DB.habitLogs.find(l => l.user_id === u && l.habit_id === habitId && l.date === t);
  const check = item.querySelector('.habit-check');
  if (check) {
    check.classList.toggle('checked', !!logged);
    check.textContent = logged ? '✓' : '';
  }

  const s = streak(habitId, t);
  const streakNum = item.querySelector('.habit-streak-num');
  if (streakNum) streakNum.textContent = s;

  const badge = s >= 30 ? '🏆' : s >= 14 ? '🥇' : s >= 7 ? '🥈' : s >= 3 ? '🥉' : '';
  const nameEl = item.querySelector('.habit-name');
  if (nameEl) {
    const oldBadge = nameEl.querySelector('.habit-badge');
    if (oldBadge) oldBadge.remove();
    if (badge) nameEl.insertAdjacentHTML('beforeend', `<span class="habit-badge">${badge}</span>`);
  }

  const ws = weekStart(new Date());
  const wl = DB.habitLogs.filter(l =>
    l.user_id === u && l.habit_id === habitId &&
    l.date >= fmtD(ws) && l.date <= fmtD(addDays(ws, 6))
  ).length;
  const weekCount = item.querySelector('.habit-week-count');
  if (weekCount) weekCount.textContent = wl;
}

function refreshHeatmap() {
  const el = document.getElementById('heatmapGrid');
  if (el) el.innerHTML = heatmapCellsHTML();
}

export const actions = {
  'habit-add': () => {
    showModal('habitAdd', `
      <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">添加习惯</h3>
      <div style="margin-bottom:12px">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">名称</label>
        <input type="text" class="input" id="hdName" placeholder="例如：晨跑">
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">分组</label>
        <input type="text" class="input" id="hdGroup" value="未分组">
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">每周目标</label>
        <input type="number" class="input" id="hdGoal" value="7" min="1" max="7">
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
        <button class="btn btn-sm" data-action="modal-close" data-modal="habitAdd" type="button">取消</button>
        <button class="btn btn-sm btn-primary" data-action="habit-save" type="button">添加</button>
      </div>
    `);
  },

  'habit-save': () => {
    const name = document.getElementById('hdName').value.trim();
    const group = document.getElementById('hdGroup').value.trim() || '未分组';
    const goal = Math.max(1, Math.min(7, parseInt(document.getElementById('hdGoal').value) || 7));
    if (!name) { toast('请输入名称', 'warning'); return; }

    DB.habits.push({
      id: uid(),
      user_id: State.user.id,
      name,
      group,
      weekly_goal: goal,
      createdAt: new Date().toISOString()
    });
    save('habits');
    emit('db:changed');
    hideModal();
    toast('已添加', 'success');
    forceReload();
  },

  'habit-toggle': (el) => {
    const t = today();
    const u = State.user.id;
    const id = el.dataset.id;

    const ex = DB.habitLogs.find(l => l.user_id === u && l.habit_id === id && l.date === t);
    if (ex) DB.habitLogs = DB.habitLogs.filter(l => l.id !== ex.id);
    else DB.habitLogs.push({ id: uid(), user_id: u, habit_id: id, date: t, createdAt: new Date().toISOString() });

    save('habitLogs');
    emit('db:changed');
    refreshHabitItem(id);
    refreshHeatmap();
  },

  /* ⭐ 关键修复：撤销时深拷贝恢复 log + 先恢复 log 再 undo + forceReload */
  'habit-del': (el) => {
    if (!confirm('删除该习惯及其所有打卡记录？')) return;
    const id = el.dataset.id;
    const h = DB.habits.find(x => x.id === id && x.user_id === State.user.id);
    if (!h) return;

    // 1) 深拷贝被删习惯的打卡记录，避免任何引用问题
    const removedLogs = JSON.parse(JSON.stringify(
      DB.habitLogs.filter(l => l.habit_id === id && l.user_id === State.user.id)
    ));

    // 2) snapshotDelete 把 habit 摘到撤销栈
    const removed = snapshotDelete('habits', id);
    if (!removed) return;

    // 3) 从 DB 里移除打卡记录
    DB.habitLogs = DB.habitLogs.filter(l => l.habit_id !== id);
    save('habits', 'habitLogs');
    emit('db:changed');

    // 4) 直接整块重绘（不再做滑出动画，避免和 forceReload 打架）
    forceReload();

    // 5) toast 带撤销
    toast('已删除习惯', 'success', {
      actions: [{
        label: '撤销',
        onClick: () => {
          // ⭐ 顺序：先恢复 log，再 undo，最后 forceReload
          // 这样 undo 内部的 flush 会把 habitLogs 一起写进去
          removedLogs.forEach(l => {
            if (!DB.habitLogs.some(x => x.id === l.id)) {
              DB.habitLogs.push({ ...l });
            }
          });
          save('habitLogs');

          if (undo()) {
            save('habits', 'habitLogs');
            emit('db:changed');
            forceReload();
            toast('已恢复习惯及打卡记录', 'success');
          } else {
            toast('撤销失败', 'error');
          }
        }
      }]
    });
  },

  'habit-makeup': (el) => {
    const id = el.dataset.id;
    const h = DB.habits.find(x => x.id === id);
    if (!h) return;
    const last7 = Array.from({ length: 7 }, (_, i) => fmtD(addDays(new Date(), -i))).reverse();

    showModal('habitMakeup', `
      <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">补打卡 · ${esc(h.name)}</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px">
        ${last7.map(ds => {
          const logged = DB.habitLogs.find(l => l.user_id === State.user.id && l.habit_id === id && l.date === ds);
          return `<button class="btn btn-sm${logged ? ' btn-primary' : ''}" data-action="habit-makeup-toggle" data-id="${id}" data-date="${ds}" type="button">${ds.slice(5)}</button>`;
        }).join('')}
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn btn-sm" data-action="modal-close" data-modal="habitMakeup" type="button">关闭</button>
      </div>
    `);
  },

  'habit-makeup-toggle': (el) => {
    const u = State.user.id;
    const { id, date } = el.dataset;
    const ex = DB.habitLogs.find(l => l.user_id === u && l.habit_id === id && l.date === date);
    if (ex) DB.habitLogs = DB.habitLogs.filter(l => l.id !== ex.id);
    else DB.habitLogs.push({ id: uid(), user_id: u, habit_id: id, date, createdAt: new Date().toISOString() });
    save('habitLogs');
    emit('db:changed');

    refreshHabitItem(id);
    refreshHeatmap();

    const logged = DB.habitLogs.find(l => l.user_id === u && l.habit_id === id && l.date === date);
    el.classList.toggle('btn-primary', !!logged);
    toast(ex ? '已取消' : '已补打卡', 'success');
  }
};
// END OF FILE