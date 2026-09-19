import { DB, State } from '../../core/db.js';
import { esc, today, fmtD, weekStart, addDays, localTime } from '../../core/utils.js';
import { renderTodoRow, renderTodoListExpandable } from '../diary/todo.js';

export const calState = {
  view: 'month',
  date: new Date(),
  selected: new Date()
};

const WEEKDAYS_CN = ['日','一','二','三','四','五','六'];

function getDays() {
  const days = [];
  if (calState.view === 'month') {
    const y = calState.date.getFullYear();
    const m = calState.date.getMonth();
    const startDay = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const prevLast = new Date(y, m, 0).getDate();
    for (let i = 0; i < startDay; i++) days.push({ date: new Date(y, m - 1, prevLast - startDay + i + 1), other: true });
    for (let i = 1; i <= daysInMonth; i++) days.push({ date: new Date(y, m, i), other: false });
    while (days.length % 7 !== 0) days.push({ date: new Date(y, m + 1, days.length - startDay - daysInMonth + 1), other: true });
  } else {
    const ws = weekStart(calState.date);
    for (let i = 0; i < 7; i++) days.push({ date: addDays(ws, i), other: false });
  }
  return days;
}

export function renderGrid() {
  const uid = State.user.id;
  const days = getDays();
  const todayStr = today();
  const selStr = fmtD(calState.selected);

  let html = `<div class="cal-grid">${WEEKDAYS_CN.map(d => `<div class="cal-weekday">${d}</div>`).join('')}`;

  days.forEach(d => {
    const ds = fmtD(d.date);
    const hasDiary = DB.diaries.some(x => x.user_id === uid && x.date === ds);
    const hasTodo = DB.todos.some(x => x.user_id === uid && x.date === ds);
    const dayMoods = DB.moods.filter(x => x.user_id === uid && x.date === ds);
    const courses = getCoursesForDate(d.date);

    const cls = [
      'cal-day',
      d.other ? 'other' : '',
      ds === todayStr ? 'today' : '',
      ds === selStr ? 'selected' : ''
    ].filter(Boolean).join(' ');

    let moodEmoji = '';
    if (dayMoods.length) {
      const last = [...dayMoods].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))[0];
      moodEmoji = last.mood;
    }

    const badges = [];
    if (hasDiary) badges.push('<span class="badge-dot diary"></span>');
    if (hasTodo) badges.push('<span class="badge-dot todo"></span>');
    if (courses.length) badges.push('<span class="badge-dot course"></span>');

    html += `<div class="${cls}" data-action="cal-show-day" data-date="${ds}">
      ${d.date.getDate()}
      ${moodEmoji ? `<span class="mood-emoji">${moodEmoji}</span>` : ''}
      ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
    </div>`;
  });

  return html + '</div>';
}

function getCoursesForDate(date) {
  const uid = State.user.id;
  const jsDay = date.getDay();
  const dayOfWeek = jsDay === 0 ? 7 : jsDay;
  const semStart = (State.user.semesterStart) || today();
  const semMonday = weekStart(new Date(semStart + 'T00:00:00'));
  const dMonday = weekStart(date);
  const weekNum = Math.floor((dMonday - semMonday) / 86400000 / 7) + 1;

  return DB.courses.filter(c => {
    if (c.user_id !== uid || c.dayOfWeek !== dayOfWeek) return false;
    return inWeek(c.weeks, weekNum);
  });
}

function inWeek(expr, weekNum) {
  if (!expr) return true;
  const parts = String(expr).split(/[,，]/);
  for (const p of parts) {
    const range = p.match(/^(\d+)\s*[-~]\s*(\d+)$/);
    if (range) {
      const s = parseInt(range[1]), e = parseInt(range[2]);
      if (weekNum >= s && weekNum <= e) return true;
    } else {
      if (parseInt(p) === weekNum) return true;
    }
  }
  return false;
}

export function renderDetail() {
  const uid = State.user.id;
  const ds = fmtD(calState.selected);

  const diaries = DB.diaries.filter(d => d.user_id === uid && d.date === ds).sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  const todos = DB.todos.filter(x => x.user_id === uid && x.date === ds).sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (a.time || '').localeCompare(b.time || '');
  });
  const courses = getCoursesForDate(calState.selected);
  const moods = DB.moods.filter(x => x.user_id === uid && x.date === ds);

  /* ⭐ 日历页待办：调共用函数，独立展开状态 calTodosExpanded */
  const todosHtml = renderTodoListExpandable(todos, {
    expandedKey: 'calTodosExpanded',
    toggleAction: 'toggle-cal-todos-expand',
    limit: 6,
    emptyHtml: '<div class="done-empty">这一天暂无待办</div>'
  });

  return `
    <div class="day-detail-card">
      <div class="day-detail-title">📌 ${ds} 详情</div>

      ${courses.length ? `
        <div class="day-section">
          <div class="day-section-title">📚 课程（${courses.length}）</div>
          ${courses.map(c => `
            <div class="day-course" style="background:${c.color}">
              <div class="dc-name">${esc(c.name)}</div>
              <div class="dc-info">第${c.startSection}-${c.endSection}节${c.location ? ' · ' + esc(c.location) : ''}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div class="day-section">
        <div class="day-section-title">
          📋 待办（${todos.length}）
          <button class="btn btn-xs btn-primary" data-action="todo-quick-add" data-date="${ds}" type="button">+ 新建</button>
        </div>
        ${todosHtml}
      </div>

      ${moods.length ? `
        <div class="day-section">
          <div class="day-section-title">😊 心情（${moods.length}）</div>
          ${moods.map(m => {
            const tags = (m.tags || []).join(' · ');
            return `<div class="mood-entry">
              <span class="mood-entry-emoji">${esc(m.mood)}</span>
              <div class="mood-entry-info">
                <div class="mood-entry-time">${esc(localTime(m.savedAt))}</div>
                ${tags ? `<div class="mood-entry-tags">${esc(tags)}</div>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>
      ` : ''}

      ${diaries.length ? `
        <div class="day-section">
          <div class="day-section-title">📝 随笔（${diaries.length}）</div>
          ${diaries.slice(0, 5).map(d => `
            <div class="diary-entry" style="cursor:default">
              <div><span class="diary-entry-time">🕐 ${esc(localTime(d.savedAt))}</span></div>
              <div style="font-size:12.5px;color:var(--text-sec);margin-top:6px;line-height:1.6;white-space:pre-wrap">${esc(d.content.slice(0, 120))}${d.content.length > 120 ? '...' : ''}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${(!courses.length && !todos.length && !moods.length && !diaries.length)
        ? '<div class="done-empty" style="padding:36px 20px">这一天还没有任何记录 ✨</div>'
        : ''}
    </div>`;
}

export function renderHeader() {
  const title = calState.view === 'month'
    ? `${calState.date.getFullYear()}年${calState.date.getMonth() + 1}月`
    : `${fmtD(weekStart(calState.date))} ~ ${fmtD(addDays(weekStart(calState.date), 6))}`;

  return `
    <div class="cal-header">
      <span class="cal-title">${title}</span>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        <button class="btn btn-xs${calState.view === 'month' ? ' btn-primary' : ''}" data-action="cal-view" data-view="month" type="button">月</button>
        <button class="btn btn-xs${calState.view === 'week' ? ' btn-primary' : ''}" data-action="cal-view" data-view="week" type="button">周</button>
        <button class="btn btn-xs" data-action="cal-prev" type="button">←</button>
        <button class="btn btn-xs" data-action="cal-next" type="button">→</button>
        <button class="btn btn-xs" data-action="cal-today" type="button">今天</button>
      </div>
    </div>`;
}

export function move(direction) {
  if (calState.view === 'month') {
    calState.date.setMonth(calState.date.getMonth() + direction);
  } else {
    calState.date = addDays(calState.date, direction * 7);
  }
}
// END OF FILE