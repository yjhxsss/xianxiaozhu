import { State, S } from '../../core/db.js';
import { esc } from '../../core/utils.js';
import { switchTab } from '../../ui/shell.js';

const STEPS = [
  { target: 'null',               icon: '🎯', title: '欢迎使用生涯助手！', desc: '集随笔、心情、待办、指标、课表、习惯、专注、总结于一体。用 2 分钟带你了解全部功能。', tips: '<b>提示：</b>随时可点「跳过」，或稍后在设置页重新查看。', position: 'center' },
  { target: "[data-tab='diary']",      icon: '🏠', title: '主页 · 一屏掌握',      desc: '左列是记录此刻 + 今日随笔，右侧是 AI 助手。',       tips: '点「生成」一次调用，同时返回建议 + 解析选中随笔。', position: 'bottom', goto: 'diary' },
  { target: '#diaryInput',             icon: '✏️', title: '记录此刻',             desc: '输入框上方有心情按钮、「📈 趋势」、「+ 记录心情」和模板按钮。', tips: '保存后光标仍在输入框，可连续写。', position: 'bottom', goto: 'diary' },
  { target: '#todayTodosList',         icon: '📋', title: '今日待办',             desc: '点击圆圈勾选完成，会立即出现在「今日完成」中。',    position: 'bottom', goto: 'diary' },
  { target: '#todayMoodList',          icon: '😊', title: '今日心情',             desc: '点击任意心情条目可展开内联编辑器。',                position: 'top',    goto: 'diary' },
  { target: '#todayDoneList',          icon: '✅', title: '今日完成',             desc: '完成的待办、专注、习惯打卡会自动汇总到这里。',      position: 'top',    goto: 'diary' },
  { target: '#diaryListPanel',         icon: '📜', title: '今日随笔',             desc: '点击随笔即可选中并供 AI 解析；悬停显示 ✎ 可编辑内容，✕ 删除。', position: 'bottom', goto: 'diary' },
  { target: '#aiAssistantPanel',       icon: '🤖', title: 'AI 助手',             desc: '一次 API 调用同时返回「今日建议」和「从随笔解析」。选中的随笔会在上方显示。', tips: '建议可采纳为待办或目标；未选中随笔时仅生成建议。', position: 'top', goto: 'diary' },
  { target: "[data-tab='calsch']",     icon: '📅', title: '日历 · 月视图',        desc: '左侧月历，点击日期右侧显示当日详情。',              position: 'bottom', goto: 'calsch' },
  { target: "[data-tab='habitgoal']",  icon: '🔥', title: '习惯与目标',           desc: '目标支持手动型与量化型，点击卡片展开详情。',        position: 'bottom', goto: 'habitgoal' },
  { target: "[data-tab='timer']",      icon: '⏱️', title: '专注计时 · 双计时器',   desc: '番茄钟和自定义计时器完全独立。',                    position: 'bottom', goto: 'timer' },
  { target: "[data-tab='summary']",    icon: '📋', title: '总结 · 数据复盘',      desc: '选时间范围，查看汇总，并与上周期对比。',            position: 'bottom', goto: 'summary' },
  { target: 'null',               icon: '🎉', title: '开始你的成长之旅！',    desc: '所有数据只保存在你的浏览器本地，完全隐私。祝你使用愉快！', position: 'center' }
];

let current = 0;
let active = false;
let _scheduled = false;

function storageKey() {
  return 'onboarding_done_v4_' + (State.user?.id || 'guest');
}

export function shouldShow() {
  return !S.get(storageKey(), false);
}

export function start() {
  if (active) return;
  if (!State.user) return;
  active = true;
  current = 0;
  render();
}

export function maybeStart() {
  if (!State.user) return;
  if (!shouldShow()) return;
  if (active || _scheduled) return;
  _scheduled = true;
  setTimeout(() => {
    _scheduled = false;
    start();
  }, 600);
}

function next() {
  current++;
  if (current >= STEPS.length) { finish(); return; }
  render();
}

function prev() {
  if (current > 0) { current--; render(); }
}

function finish() {
  active = false;
  _scheduled = false;
  S.set(storageKey(), true);
  const ov = document.getElementById('onboardingOverlay');
  if (ov) ov.remove();
}

function render() {
  try {
    const old = document.getElementById('onboardingOverlay');
    if (old) old.remove();

    const step = STEPS[current];
    if (!step) { finish(); return; }

    if (step.goto) {
      try { switchTab(step.goto); } catch (e) { console.warn('[onboarding] switchTab failed:', e); }
    }

    // 等 DOM 渲染 + 滚动完成后定位气泡
    setTimeout(() => renderBubble(step), 80);
  } catch (err) {
    console.error('[onboarding] render failed:', err);
    active = false;
    const ov = document.getElementById('onboardingOverlay');
    if (ov) ov.remove();
  }
}

function renderBubble(step) {
  const ov = document.createElement('div');
  ov.className = 'onboarding-overlay';
  ov.id = 'onboardingOverlay';

  const CENTERED = 'left:50%;top:50%;transform:translate(-50%,-50%);width:400px';
  let spotlightStyle = '';
  let bubbleStyle = '';

  if (step.target && step.target !== 'null') {
    const el = document.querySelector(step.target);
    if (el) {
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}

      const r = el.getBoundingClientRect();
      const pad = 10;
      spotlightStyle = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;

      const bubbleW = 360;
      let bx = Math.max(12, Math.min(window.innerWidth - bubbleW - 12, r.left + r.width / 2 - bubbleW / 2));
      const bubbleH = 340;
      let by = step.position === 'top' ? r.top - bubbleH - 20 : r.bottom + 20;
      if (by + bubbleH > window.innerHeight - 12) by = Math.max(12, r.top - bubbleH - 20);
      if (by < 12) by = 12;
      bubbleStyle = `left:${bx}px;top:${by}px;width:${bubbleW}px`;
    }
  }

  if (!bubbleStyle) {
    bubbleStyle = CENTERED;
    ov.classList.add('dim');
  }

  const dots = STEPS.map((_, i) => `<div class="op-dot${i === current ? ' active' : ''}"></div>`).join('');
  const isFirst = current === 0;
  const isLast = current === STEPS.length - 1;
  const descFormatted = step.desc.replace(/\*\*(.+?)\*\*/g, '<b style="color:var(--accent)">$1</b>');

  ov.innerHTML = `
    ${spotlightStyle ? `<div class="onboarding-spotlight" style="${spotlightStyle}"></div>` : ''}
    <div class="onboarding-bubble" style="${bubbleStyle}">
      <div class="ob-step">步骤 ${current + 1} / ${STEPS.length}</div>
      <div class="ob-title"><span class="ob-icon">${step.icon}</span><span>${esc(step.title)}</span></div>
      <div class="ob-desc">${descFormatted}</div>
      ${step.tips ? `<div class="ob-tips">${step.tips}</div>` : ''}
      <div class="ob-actions">
        <div class="onboarding-progress">${dots}</div>
        <div class="onboarding-actions">
          ${!isFirst ? `<button class="btn btn-sm btn-ghost" data-action="ob-prev" type="button">← 上一步</button>` : ''}
          <button class="btn btn-sm btn-ghost" data-action="ob-skip" type="button">跳过</button>
          <button class="btn btn-sm btn-primary" data-action="ob-next" type="button">${isLast ? '开始使用' : '下一步 →'}</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(ov);
}

/* 全局点击拦截
 * 只在覆盖层真实存在时生效；
 * 捕获阶段拦截气泡外的点击，避免用户误操作下面的元素。
 * 只阻止 click，不影响 input/textarea/keydown。
 */
document.addEventListener('click', e => {
  const ov = document.getElementById('onboardingOverlay');
  if (!active || !ov) return;
  if (!e.target.closest('.onboarding-bubble')) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

/* 键盘：→ / Enter 下一步，← 上一步，Esc 跳过 */
document.addEventListener('keydown', e => {
  if (!active) return;
  if (e.key === 'Escape') { e.preventDefault(); finish(); }
  else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
});

export const actions = {
  'ob-next': () => next(),
  'ob-prev': () => prev(),
  'ob-skip': () => finish()
};

export default {
  id: 'onboarding',
  name: '新手引导',
  hidden: true,
  actions,
  maybeStart,
  start,
  shouldShow
};