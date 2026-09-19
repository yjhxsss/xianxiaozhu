import { DB, State, save } from '../../core/db.js';
import { esc, today, uid, pad } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';

// ============ 模块级状态（切板块时保留，切用户时重置） ============
export const pomoState = {
  userId: null,          // ← 新增：记住这个状态属于哪个用户
  phase: null,           // null | 'work' | 'break'
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

function workSeconds() {
  return (State.timer.work || 25 * 60);
}
function breakSeconds() {
  return (State.timer.break || 5 * 60);
}

// ← 新增：切用户时调用，重置所有状态
export function resetForUser(userId) {
  if (pomoState.userId === userId) return;
  // 换用户了：停掉旧定时器 + 清空
  if (pomoState.interval) { clearInterval(pomoState.interval); pomoState.interval = null; }
  pomoState.userId = userId;
  pomoState.phase = null;
  pomoState.running = false;
  pomoState.total = workSeconds();
  pomoState.seconds = workSeconds();
  pomoState.endAt = 0;
}

function updateUI() {
  const display = document.getElementById('pomoDisplay');
  if (!display) return;

  display.textContent = fmt(pomoState.seconds);

  const ring = document.getElementById('pomoRing');
  if (ring) {
    const C = 2 * Math.PI * 68;
    const ratio = pomoState.total > 0 ? pomoState.seconds / pomoState.total : 1;
    ring.style.strokeDasharray = String(C);
    ring.style.strokeDashoffset = String(C * (1 - ratio));
  }

  const label = document.getElementById('pomoStatusLabel');
  if (label) {
    let txt = 'READY';
    if (pomoState.running) txt = pomoState.phase === 'break' ? 'BREAK' : 'FOCUS';
    else if (pomoState.seconds > 0 && pomoState.seconds < pomoState.total) txt = 'PAUSED';
    label.textContent = txt;
  }

  const btn = document.getElementById('pomoStartBtn');
  if (btn) {
    if (pomoState.running) btn.textContent = '⏸ 暂停';
    else if (pomoState.seconds > 0 && pomoState.seconds < pomoState.total) btn.textContent = '▶ 继续';
    else btn.textContent = '▶ 开始';
    btn.classList.toggle('running', pomoState.running);
  }

  const card = document.getElementById('pomoCard');
  if (card) {
    card.classList.toggle('timer-running', pomoState.running);
    card.classList.toggle('timer-paused', !pomoState.running && pomoState.seconds > 0 && pomoState.seconds < pomoState.total);
    card.classList.toggle('timer-break', pomoState.phase === 'break');
  }
}

function tick() {
  if (!pomoState.running) return;
  const remain = Math.max(0, Math.round((pomoState.endAt - Date.now()) / 1000));
  pomoState.seconds = remain;
  if (remain <= 0) {
    clearInterval(pomoState.interval);
    pomoState.interval = null;
    pomoState.running = false;
    onComplete();
    return;
  }
  updateUI();
}

function onComplete() {
  const finished = pomoState.phase;
  const minutes = Math.round(pomoState.total / 60);

  // 保护：如果用户已经切换/登出，不要写数据
  if (!State.user) {
    pomoState.phase = null;
    pomoState.total = workSeconds();
    pomoState.seconds = workSeconds();
    pomoState.endAt = 0;
    return;
  }

  if (finished === 'work') {
    DB.focusSessions.push({
      id: uid(),
      user_id: State.user.id,
      date: today(),
      duration_minutes: minutes,
      mode: 'pomodoro',
      note: '',
      tag: State.focusTag || '学习',
      completedAt: new Date().toISOString()
    });
    save('focusSessions');
    emit('db:changed');
    toast(`🍅 番茄钟完成！专注 ${minutes} 分钟`, 'success');

    pomoState.phase = 'break';
    pomoState.total = breakSeconds();
    pomoState.seconds = breakSeconds();
  } else {
    toast('☕ 休息结束', 'info');
    pomoState.phase = null;
    pomoState.total = workSeconds();
    pomoState.seconds = workSeconds();
  }
  pomoState.endAt = 0;
  rerender();
}

// ============ 对外接口 ============
export function start() {
  if (!State.user) return;

  // 保护：如果 state 属于别的用户，先重置
  if (pomoState.userId !== State.user.id) {
    resetForUser(State.user.id);
  }

  if (pomoState.running) {
    clearInterval(pomoState.interval);
    pomoState.interval = null;
    pomoState.running = false;
    updateUI();
    return;
  }

  if (!pomoState.phase) {
    pomoState.phase = 'work';
    pomoState.total = workSeconds();
    pomoState.seconds = workSeconds();
  }

  pomoState.endAt = Date.now() + pomoState.seconds * 1000;
  pomoState.running = true;
  pomoState.interval = setInterval(tick, 250);
  updateUI();
}

export function reset() {
  if (pomoState.interval) { clearInterval(pomoState.interval); pomoState.interval = null; }
  pomoState.phase = null;
  pomoState.running = false;
  pomoState.total = workSeconds();
  pomoState.seconds = workSeconds();
  pomoState.endAt = 0;
  updateUI();
}

export function render() {
  const current = pomoState.phase ? pomoState.seconds : workSeconds();
  const C = 2 * Math.PI * 68;
  const ratio = pomoState.total > 0 ? pomoState.seconds / pomoState.total : 1;
  const offset = pomoState.phase ? C * (1 - ratio) : 0;

  let statusText = 'READY';
  if (pomoState.running) statusText = pomoState.phase === 'break' ? 'BREAK' : 'FOCUS';
  else if (pomoState.seconds > 0 && pomoState.seconds < pomoState.total) statusText = 'PAUSED';

  let btnText = '▶ 开始';
  if (pomoState.running) btnText = '⏸ 暂停';
  else if (pomoState.seconds > 0 && pomoState.seconds < pomoState.total) btnText = '▶ 继续';

  const cardCls = [
    'panel', 'timer-card',
    pomoState.running ? 'timer-running' : '',
    !pomoState.running && pomoState.seconds > 0 && pomoState.seconds < pomoState.total ? 'timer-paused' : '',
    pomoState.phase === 'break' ? 'timer-break' : ''
  ].filter(Boolean).join(' ');

  return `
    <div class="${cardCls}" id="pomoCard">
      <div class="panel-title" style="justify-content:center">
        <span class="title-icon">🍅</span>番茄时钟
      </div>

      <div class="timer-tag-row">
        ${['学习','工作','阅读','写作','编程','运动'].map(t => `
          <button class="timer-tag${State.focusTag === t ? ' selected' : ''}" data-action="focus-tag" data-tag="${t}" type="button">${t}</button>
        `).join('')}
      </div>

      <div class="timer-ring-wrap">
        <svg class="timer-ring" viewBox="0 0 160 160">
          <circle class="ring-bg" cx="80" cy="80" r="68"/>
          <circle class="ring-progress" id="pomoRing" cx="80" cy="80" r="68"
                  style="stroke-dasharray:${C};stroke-dashoffset:${offset}"/>
        </svg>
        <div class="timer-center">
          <div class="timer-display" id="pomoDisplay">${fmt(current)}</div>
          <div class="timer-status" id="pomoStatusLabel">${statusText}</div>
        </div>
      </div>

      <div class="timer-buttons">
        <button class="btn btn-primary" id="pomoStartBtn" data-action="pomo-start" type="button">${btnText}</button>
        <button class="btn" data-action="pomo-reset" type="button" title="重置">🔄</button>
      </div>

      <div class="timer-hint">
        工作 ${Math.round(workSeconds() / 60)} 分钟 / 休息 ${Math.round(breakSeconds() / 60)} 分钟
      </div>
    </div>`;
}

// 供外部在切到 timer 板块后调用（恢复 UI）
export function afterMount() {
  updateUI();
}