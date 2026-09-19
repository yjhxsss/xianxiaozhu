import { DB, State, save } from '../../core/db.js';
import { esc, today, fmtD, weekStart, addDays, WEEKDAYS, SECTIONS, COURSE_COLORS } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';
import { uid } from '../../core/utils.js';

export const schState = {
  weekOffset: 0
};

/* ⭐ 节次时间表：优先读用户自定义，回退到内置 SECTIONS */
export function getSections() {
  const custom = DB.settings && DB.settings.sectionTimes;
  if (Array.isArray(custom) && custom.length >= 1) {
    const ok = custom.every(x => x && typeof x.n === 'number' && x.start && x.end);
    if (ok) return custom;
  }
  return SECTIONS;
}

/* ⭐ 统一以 State.user.semesterStart 为准（与设置页一致） */
function currentWeekNum() {
  const start = State.user && State.user.semesterStart;
  if (!start) return null;
  const monday = getViewMonday();
  const startDate = new Date(start + 'T00:00:00');
  const startDay = startDate.getDay();
  const startDiff = startDay === 0 ? -6 : 1 - startDay;
  startDate.setDate(startDate.getDate() + startDiff);
  const diffDays = Math.round((monday - startDate) / 86400000);
  return Math.floor(diffDays / 7) + 1;
}

function getViewMonday() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff + schState.weekOffset * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

function weekLabel() {
  const wk = currentWeekNum();
  if (wk !== null && wk > 0) {
    return `第 ${wk} 周${schState.weekOffset === 0 ? ' · 本周' : ''}`;
  }
  if (schState.weekOffset === 0) return '本周';
  if (schState.weekOffset === -1) return '上周';
  if (schState.weekOffset === 1) return '下周';
  if (schState.weekOffset < 0) return `${-schState.weekOffset} 周前`;
  return `${schState.weekOffset} 周后`;
}

function inWeek(expr, weekNum) {
  if (weekNum === null) return true;
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

export function render() {
  const monday = getViewMonday();
  const sunday = addDays(monday, 6);
  const wk = currentWeekNum();
  const hasSemester = !!(State.user && State.user.semesterStart);
  const courses = DB.courses || [];
  const uid = State.user.id;
  const secs = getSections();

  const headers = WEEKDAYS.map((w, i) => {
    const d = addDays(monday, i);
    const isToday = fmtD(d) === today();
    return `<div class="sch-head${isToday ? ' today' : ''}">
      <div class="sch-head-name">周${w}</div>
      <div class="sch-head-date">${d.getMonth() + 1}/${d.getDate()}</div>
    </div>`;
  }).join('');

  let rows = '';
  for (let s = 1; s <= secs.length; s++) {
    const sec = secs[s - 1];
    rows += `<div class="sch-time">
      <div class="sch-time-num">${s}</div>
      <div class="sch-time-range">${sec.start}<br>${sec.end}</div>
    </div>`;

    for (let d = 0; d < 7; d++) {
      const day = d + 1;

      const startingCourses = courses.filter(c =>
        c.user_id === uid &&
        c.dayOfWeek === day &&
        c.startSection === s &&
        inWeek(c.weeks, wk)
      );

      const crossing = courses.some(c =>
        c.user_id === uid &&
        c.dayOfWeek === day &&
        c.startSection < s &&
        c.endSection >= s &&
        inWeek(c.weeks, wk)
      );

      if (startingCourses.length > 0) {
        const maxEnd = Math.max(...startingCourses.map(c => c.endSection || s));
        const span = Math.max(1, maxEnd - s + 1);
        const isConflict = startingCourses.length > 1;

        rows += `<div class="sch-stack${isConflict ? ' conflict' : ''}"
                      style="grid-column:${d + 2};grid-row:${s + 1} / span ${span}">
          ${startingCourses.map(c => `
            <div class="sch-course" style="background:${c.color}"
                 data-action="course-detail" data-id="${c.id}">
              <div class="sch-course-name">${esc(c.name)}</div>
              ${c.location ? `<div class="sch-course-info">📍 ${esc(c.location)}</div>` : ''}
            </div>
          `).join('')}
          ${isConflict ? `<div class="sch-conflict-badge" title="时间冲突：${startingCourses.length} 门">⚠️</div>` : ''}
        </div>`;
      } else if (!crossing) {
        rows += `<div class="sch-empty" style="grid-column:${d + 2};grid-row:${s + 1}"></div>`;
      }
    }
  }

  return `
    <div class="panel">
      <div class="panel-title">
        <span class="title-icon">📅</span>周课表
        <div class="week-nav" style="margin-left:auto">
          <button class="btn btn-xs" data-action="week-prev" type="button">←</button>
          <span class="week-label">${weekLabel()}</span>
          <button class="btn btn-xs" data-action="week-next" type="button">→</button>
          <button class="btn btn-xs" data-action="week-current" type="button">本周</button>
        </div>
        <button class="btn btn-xs btn-ghost" data-action="schedule-set-start" type="button" title="设置学期与作息">⚙️</button>
        <button class="btn btn-xs" data-action="course-import" type="button" title="批量导入课表">📄 导入</button>
        <button class="btn btn-xs btn-primary" data-action="course-new" type="button">+ 课程</button>
      </div>

      <div class="week-range">
        ${fmtD(monday)} ~ ${fmtD(sunday)}
        ${!hasSemester ? '<span style="color:var(--warning);margin-left:8px;font-size:11px">· 点 ⚙️ 设置开学日期可显示真实周次</span>' : ''}
      </div>

      ${courses.length
        ? `<div class="sch-wrap"><div class="sch-grid"><div></div>${headers}${rows}</div></div>`
        : '<div class="done-empty">还没有课程，点右上角添加 📅</div>'}
    </div>`;
}

/* ============================================================
 * ⭐ 作息表编辑相关工具
 * ============================================================ */

/* 从弹窗里读取当前输入框的值（顺序即 n = 1,2,3...） */
function readSectionTimesFromModal() {
  const list = document.getElementById('secTimesList');
  if (!list) return null;
  const rows = list.querySelectorAll('.sec-time-row');
  const result = [];
  let i = 1;
  for (const row of rows) {
    const s = row.querySelector('input[data-field="start"]')?.value;
    const e = row.querySelector('input[data-field="end"]')?.value;
    if (s && e) result.push({ n: i, start: s, end: e });
    i++;
  }
  return result;
}

/* 构建作息表行的 HTML（每行带 ✕ 删除按钮） */
function buildSectionRowsHtml(secs) {
  return secs.map((s, i) => {
    const n = s.n || (i + 1);
    return `
      <div class="sec-time-row">
        <span class="sec-n">第 ${n} 节</span>
        <input type="time" class="input sec-time-input" data-field="start" value="${esc(s.start || '')}">
        <span class="sec-sep">—</span>
        <input type="time" class="input sec-time-input" data-field="end" value="${esc(s.end || '')}">
        <button class="sec-del-btn" data-action="schedule-remove-section" data-idx="${i}" type="button" title="删除本节">✕</button>
      </div>`;
  }).join('');
}

/* 重新渲染整个作息列表（增删后调用） */
function renderSectionList(secs) {
  const list = document.getElementById('secTimesList');
  if (!list) return;
  const scrollTop = list.scrollTop;
  list.innerHTML = buildSectionRowsHtml(secs);
  list.scrollTop = scrollTop;
}

/* 时间加法：'HH:MM' + N 分钟 → 'HH:MM'（封顶 23:59） */
function addMinutes(hhmm, mins) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return '';
  const [h, m] = hhmm.split(':').map(Number);
  let total = h * 60 + m + mins;
  if (total >= 24 * 60) total = 24 * 60 - 1;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/* ============================================================
 * Actions
 * ============================================================ */

export const actions = {
  'week-prev': () => { schState.weekOffset--; rerender(); },
  'week-next': () => { schState.weekOffset++; rerender(); },
  'week-current': () => { schState.weekOffset = 0; rerender(); },

  /* ⭐ 学期 + 作息：合并弹窗 */
  'schedule-set-start': () => {
    const current = (State.user && State.user.semesterStart) || '';
    const secs = getSections();

    showModal('semesterModal', `
      <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">📅 学期与作息</h3>

      <div style="margin-bottom:16px">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px;font-weight:700">开学那一周的任意日期</label>
        <input type="date" class="input" id="semStart" value="${esc(current)}">
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.5">
          用于计算"第几周"。清空后周课表不显示真实周次。
        </div>
      </div>

      <div style="padding-top:14px;border-top:1px dashed var(--border);margin-bottom:6px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <label style="font-size:12.5px;color:var(--text-sec);font-weight:700">作息表（每节起止时间）</label>
          <button class="btn btn-xs btn-ghost" data-action="schedule-reset-sections" type="button">恢复默认</button>
        </div>
        <div style="font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:10px">
          用于课表文本导入时的"时间 → 节次"映射，以及 AI 审查课表。<b>如果你们学校作息和默认不一样，务必在这里改</b>。
        </div>
        <div class="sec-time-list" id="secTimesList">
          ${buildSectionRowsHtml(secs)}
        </div>
        <div style="margin-top:10px;display:flex;justify-content:center">
          <button class="btn btn-xs" data-action="schedule-add-section" type="button">＋ 增加一节</button>
        </div>
      </div>

      <div style="display:flex;gap:10px;justify-content:space-between;margin-top:18px;flex-wrap:wrap">
        ${current ? `<button class="btn btn-sm btn-danger" data-action="schedule-clear-start" type="button">清除开学日期</button>` : '<span></span>'}
        <div style="display:flex;gap:10px">
          <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
          <button class="btn btn-sm btn-primary" data-action="schedule-save-all" type="button">💾 保存</button>
        </div>
      </div>
    `);
  },

  /* ⭐ 增加一节：默认接在最后一节之后（间隔 10 分钟，时长 45 分钟） */
  'schedule-add-section': () => {
    const current = readSectionTimesFromModal();
    if (!current) return;
    if (current.length >= 20) {
      toast('最多支持 20 节', 'warning');
      return;
    }
    const last = current[current.length - 1];
    let newStart = '', newEnd = '';
    if (last && last.end) {
      newStart = addMinutes(last.end, 10);
      newEnd = addMinutes(newStart, 45);
    } else {
      newStart = '19:00';
      newEnd = '19:45';
    }
    current.push({ n: current.length + 1, start: newStart, end: newEnd });
    renderSectionList(current);
    /* 自动滚到新加的那一节 */
    setTimeout(() => {
      const list = document.getElementById('secTimesList');
      if (list) list.scrollTop = list.scrollHeight;
    }, 30);
  },

  /* ⭐ 删除一节：至少保留 1 节 */
  'schedule-remove-section': (el) => {
    const current = readSectionTimesFromModal();
    if (!current) return;
    if (current.length <= 1) {
      toast('至少保留 1 节', 'warning');
      return;
    }
    const idx = parseInt(el.dataset.idx);
    if (isNaN(idx) || idx < 0 || idx >= current.length) return;
    current.splice(idx, 1);
    /* 重排 n（1..len） */
    const renumbered = current.map((s, i) => ({ n: i + 1, start: s.start, end: s.end }));
    renderSectionList(renumbered);
  },

  /* ⭐ 把弹窗里的时间恢复为默认 SECTIONS（含节次数，不写库，用户需点保存） */
  'schedule-reset-sections': () => {
    renderSectionList(SECTIONS.map((s, i) => ({ n: i + 1, start: s.start, end: s.end })));
    toast('已恢复为默认作息（点保存生效）', 'info');
  },

  /* ⭐ 一次性保存开学日期 + 作息 */
  'schedule-save-all': () => {
    /* ---- 1. 读开学日期 ---- */
    const startVal = (document.getElementById('semStart')?.value || '').trim();

    /* ---- 2. 读作息表 ---- */
    const secs = readSectionTimesFromModal();
    if (!secs || !secs.length) {
      toast('作息表不能为空', 'warning');
      return;
    }

    /* ---- 3. 校验 ---- */
    for (const sec of secs) {
      if (!sec.start || !sec.end) {
        toast(`第 ${sec.n} 节：时间不能为空`, 'warning');
        return;
      }
      if (sec.start >= sec.end) {
        toast(`第 ${sec.n} 节：结束时间必须晚于开始`, 'warning');
        return;
      }
    }
    for (let i = 1; i < secs.length; i++) {
      if (secs[i].start < secs[i - 1].end) {
        toast(`第 ${secs[i].n} 节开始早于第 ${secs[i - 1].n} 节结束`, 'warning');
        return;
      }
    }

    /* ---- 4. 写库 ---- */
    const u = DB.users.find(x => x.id === State.user.id);
    if (u) u.semesterStart = startVal;
    State.user.semesterStart = startVal;
    save('users');

    if (!DB.settings) DB.settings = {};
    DB.settings.sectionTimes = secs;
    save('settings');

    hideModal();
    toast(`已保存：开学 ${startVal || '未设置'} · 作息 ${secs.length} 节`, 'success');
    rerender();
  },

  'schedule-clear-start': () => {
    if (!confirm('清除开学日期？周课表将不再显示真实周次。')) return;
    const u = DB.users.find(x => x.id === State.user.id);
    if (u) u.semesterStart = '';
    State.user.semesterStart = '';
    save('users');
    hideModal();
    toast('已清除开学日期', 'success');
    rerender();
  },

  'course-new': () => openModal(),
  'course-detail': (el) => {
    const c = DB.courses.find(x => x.id === el.dataset.id);
    if (c) openModal(c);
  },
  'course-save': () => {
    const idEl = document.getElementById('cId');
    const id = idEl ? idEl.value : '';
    const name = document.getElementById('cName').value.trim();
    if (!name) { toast('请输入课程名称', 'warning'); return; }

    const data = {
      name,
      teacher: document.getElementById('cTeacher').value.trim(),
      location: document.getElementById('cLocation').value.trim(),
      dayOfWeek: parseInt(document.getElementById('cDay').value),
      startSection: parseInt(document.getElementById('cStart').value),
      endSection: parseInt(document.getElementById('cEnd').value),
      weeks: document.getElementById('cWeeks').value.trim() || '1-16',
      color: document.getElementById('cColor').value
    };

    if (data.endSection < data.startSection) { toast('结束节次不能早于开始', 'warning'); return; }

    if (id) {
      const c = DB.courses.find(x => x.id === id);
      if (c) Object.assign(c, data);
    } else {
      DB.courses.push({ id: uid(), user_id: State.user.id, ...data, createdAt: new Date().toISOString() });
    }

    save('courses');
    emit('db:changed');
    hideModal();
    toast('已保存', 'success');
    rerender();
  },
  'course-del': (el) => {
    if (!confirm('删除这门课程？')) return;
    DB.courses = DB.courses.filter(c => c.id !== el.dataset.id);
    save('courses');
    emit('db:changed');
    hideModal();
    toast('已删除', 'success');
    rerender();
  }
};

function openModal(edit) {
  const isEdit = !!edit;
  const c = edit || {};
  const secs = getSections();
  const secOpts = (sel) => secs.map((s, i) => {
    const n = s.n || (i + 1);
    return `<option value="${n}"${sel === n ? ' selected' : ''}>第${n}节 (${s.start})</option>`;
  }).join('');

  showModal('courseModal', `
    <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">${isEdit ? '✏️ 编辑课程' : '📅 添加课程'}</h3>
    <input type="hidden" id="cId" value="${edit ? esc(c.id) : ''}">

    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">课程名称</label>
      <input type="text" class="input" id="cName" value="${esc(c.name || '')}" placeholder="例如：高等数学">
    </div>

    <div style="display:flex;gap:10px;margin-bottom:12px">
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">教师</label>
        <input type="text" class="input" id="cTeacher" value="${esc(c.teacher || '')}">
      </div>
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">地点</label>
        <input type="text" class="input" id="cLocation" value="${esc(c.location || '')}">
      </div>
    </div>

    <div style="display:flex;gap:10px;margin-bottom:12px">
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">星期</label>
        <select class="input" id="cDay">
          ${WEEKDAYS.map((w, i) => `<option value="${i + 1}"${c.dayOfWeek === i + 1 ? ' selected' : ''}>周${w}</option>`).join('')}
        </select>
      </div>
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">颜色</label>
        <select class="input" id="cColor">
          ${COURSE_COLORS.map(col => `<option value="${col}"${c.color === col ? ' selected' : ''}>${col}</option>`).join('')}
        </select>
      </div>
    </div>

    <div style="display:flex;gap:10px;margin-bottom:12px">
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">开始节次</label>
        <select class="input" id="cStart">${secOpts(c.startSection || 1)}</select>
      </div>
      <div style="flex:1">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">结束节次</label>
        <select class="input" id="cEnd">${secOpts(c.endSection || 2)}</select>
      </div>
    </div>

    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">周数</label>
      <input type="text" class="input" id="cWeeks" value="${esc(c.weeks || '1-16')}" placeholder="例如 1-16 或 1,3,5">
    </div>

    <div style="display:flex;gap:10px;justify-content:space-between;margin-top:18px">
      ${isEdit ? `<button class="btn btn-sm btn-danger" data-action="course-del" data-id="${c.id}" type="button">删除</button>` : '<span></span>'}
      <div style="display:flex;gap:10px">
        <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
        <button class="btn btn-sm btn-primary" data-action="course-save" type="button">${isEdit ? '保存' : '添加'}</button>
      </div>
    </div>
  `);
}