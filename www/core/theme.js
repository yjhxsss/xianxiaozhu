import { State, S } from './db.js';

let mediaQuery = null;
let _themeDispatchTimer = null;

export function init() {
  apply();
  if (!mediaQuery) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (State.theme === 'auto') apply();
    };
    if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', onChange);
    else if (mediaQuery.addListener) mediaQuery.addListener(onChange);
  }
}

export function apply() {
  const effective = State.theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : State.theme;
  document.documentElement.setAttribute('data-theme', effective);
  document.documentElement.setAttribute('data-accent', State.accent || 'violet');
  const btn = document.querySelector('.theme-toggle');
  if (btn) btn.textContent = icon();

  /* ⭐ 通知所有图表模块重绘（防抖，避免连续 apply 多次触发） */
  if (_themeDispatchTimer) clearTimeout(_themeDispatchTimer);
  _themeDispatchTimer = setTimeout(() => {
    _themeDispatchTimer = null;
    window.dispatchEvent(new CustomEvent('theme:changed'));
  }, 40);
}

export function cycle() {
  const order = ['dark', 'light', 'auto'];
  State.theme = order[(order.indexOf(State.theme) + 1) % order.length];
  S.set('theme', State.theme);
  apply();
  return State.theme;
}

export function icon() {
  return { dark: '🌙', light: '☀️', auto: '🌓' }[State.theme] || '🌙';
}

export function setAccent(k) {
  State.accent = k;
  S.set('accent', k);
  apply();
}