import { DB, State, save } from '../../core/db.js';
import { today, uid, pad } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';

// ============ 模块级状态 ============
export const customState = {
  userId: null,          // ← 新增
  running: false,
  seconds: 0,
  total: 0,
  endAt: 0,
  interval: null
};

function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  return pad(Math.floor(sec / 60)) + ':' + pad(sec % 60);
}

// ← 新增：切用户时调用
export function resetForUser(userId) {
  if (customState.userId === userId) return;
  if (customState.interval) { clearInterval(customState.interval); customState.interval = null; }
  customState.userId = userId;
  customState.running = false;
  customState.seconds = 0;
  customState.total = 0;
  customState.endAt = 0;
}

function updateUI() {
  const display = document.getElementById('customDisplay');
  if (!display) return;

  display.textContent = fmt(customState.seconds);

  const ring = document.getElementById('customRing');
  if (ring) {
    const C = 2 * Math.PI * 68;
    const ratio = customState.total > 0 ? customState.seconds / customState.total : 1;
    ring.style.strokeDasharray = String(C);
    ring.style.strokeDashoffset = String(C * (1 - ratio));
  }

  const label = document.getElementById('customStatusLabel');
  if (label) {
    let txt = 'READY';
    if (customState.running) txt = 'COUNTING';
    else if (customState.seconds > 0 && customState.seconds < customState.total) txt = 'PAUSED';
    label.textContent = txt;
  }

  const btn = document.getElementById('customStartBtn');
  if (btn) {
    if (customState.running) btn.textContent = '⏸ 暂停';
    else if (customState.seconds > 0 && customState.seconds < customState.total) btn.textContent = '▶ 继续';
    else btn.textContent = '▶ 开始';
    btn.classList.toggle('running', customState.running);
  }

  const card = document.getElementById('customCard');
  if (card) {
    card.classList.toggle('timer-running', customState.running);
    card.classList.toggle('timer-paused', !customState.running && customState.total > 0 && customState.seconds > 0 && customState.seconds < customState.total);
  }
}

function tick() {
  if (!customState.running) return;
  const remain = Math.max(0, Math.round((customState.endAt - Date.now()) / 1000));
  customState.seconds = remain;
  if (remain <= 0) {
    clearInterval(customState.interval);
    customState.interval = null;
    customState.running = false;
    onComplete();
    return;
  }
  updateUI();
}

function onComplete() {
  const minutes = Math.round(customState.total / 60);

  // 保护：用户已登出就不写数据
  if (!State.user) {
    customState.seconds = 0;
    customState.total = 0;
    customState.endAt = 0;
    return;
  }

  DB.focusSessions.push({
    id: uid(),
    user_id: State.user.id,
    date: today(),
    duration_minutes: minutes,
    mode: 'custom',
    note: '',
    tag: State.focusTag || '学习',
    completedAt: new Date().toISOString()
  });
  save('focusSessions');
  emit('db:changed');
  toast(`⏲️ 计时完成 ${minutes} 分钟`, 'success');

  customState.seconds = 0;
  customState.total = 0;
  customState.endAt = 0;
  rerender();
}

// ============ 对外接口 ============
export function start() {
  if (!State.user) return;

  // 保护：如果 state 属于别的用户，先重置
  if (customState.userId !== State.user.id) {
    resetForUser(State.user.id);
  }

  if (customState.running) {
    clearInterval(customState.interval);
    customState.interval = null;
    customState.running = false;
    updateUI();
    return;
  }

  if (!customState.total || customState.seconds <= 0) {
    const el = document.getElementById('customMin');
    const mins = el ? Math.max(1, Math.min(180, parseInt(el.value) || 10)) : 10;
    State.customInput = mins;
    customState.total = mins * 60;
    customState.seconds = mins * 60;
  }

  customState.endAt = Date.now() + customState.seconds * 1000;
  customState.running = true;
  customState.interval = setInterval(tick, 250);
  updateUI();
}

export function reset() {
  if (customState.interval) { clearInterval(customState.interval); customState.interval = null; }
  customState.running = false;
  customState.seconds = 0;
  customState.total = 0;
  customState.endAt = 0;
  updateUI();
}

export function setPreset(min) {
  State.customInput = min;
  if (customState.interval) { clearInterval(customState.interval); customState.interval = null; }
  customState.running = false;
  customState.total = min * 60;
  customState.seconds = min * 60;
  customState.endAt = 0;
  const el = document.getElementById('customMin');
  if (el) el.value = min;
  updateUI();
  toast(`已设置 ${min} 分钟`, 'success');
}

export function render() {
  const current = customState.total > 0 ? customState.seconds : (State.customInput || 10) * 60;
  const C = 2 * Math.PI * 68;
  const ratio = customState.total > 0 ? customState.seconds / customState.total : 1;
  const offset = customState.total > 0 ? C * (1 - ratio) : 0;

  let statusText = 'READY';
  if (customState.running) statusText = 'COUNTING';
  else if (customState.total > 0 && customState.seconds > 0 && customState.seconds < customState.total) statusText = 'PAUSED';

  let btnText = '▶ 开始';
  if (customState.running) btnText = '⏸ 暂停';
  else if (customState.total > 0 && customState.seconds > 0 && customState.seconds < customState.total) btnText = '▶ 继续';

  const cardCls = [
    'panel', 'timer-card',
    customState.running ? 'timer-running' : '',
    !customState.running && customState.total > 0 && customState.seconds > 0 && customState.seconds < customState.total ? 'timer-paused' : ''
  ].filter(Boolean).join(' ');

  return `
    <div class="${cardCls}" id="customCard">
      <div class="panel-title" style="justify-content:center">
        <span class="title-icon">⏲️</span>自定义计时
      </div>

      <div class="timer-ring-wrap">
        <svg class="timer-ring" viewBox="0 0 160 160">
          <circle class="ring-bg" cx="80" cy="80" r="68"/>
          <circle class="ring-progress break" id="customRing" cx="80" cy="80" r="68"
                  style="stroke-dasharray:${C};stroke-dashoffset:${offset}"/>
        </svg>
        <div class="timer-center">
          <div class="timer-display" id="customDisplay">${fmt(current)}</div>
          <div class="timer-status" id="customStatusLabel">${statusText}</div>
        </div>
      </div>

      <div class="timer-preset-row">
        <input type="number" class="input timer-input" id="customMin"
               value="${State.customInput || 10}" min="1" max="180">
        <span style="font-size:12px;color:var(--text-muted)">分钟</span>
        ${[5, 10, 15, 30, 60].map(m => `
          <button class="btn btn-xs" data-action="timer-preset" data-min="${m}" type="button">${m}</button>
        `).join('')}
      </div>

      <div class="timer-buttons">
        <button class="btn btn-primary" id="customStartBtn" data-action="custom-start" type="button">${btnText}</button>
        <button class="btn" data-action="custom-reset" type="button" title="重置">🔄</button>
      </div>
    </div>`;
}

export function afterMount() {
  updateUI();
}