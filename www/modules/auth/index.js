import { DB, State, save, flush, S, resetUserScopedState, loadUserConfig, clearUserConfigInMemory } from '../../core/db.js';
import { uid, esc } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { emit } from '../../core/bus.js';
import { resetForUser as resetPomoForUser, pomoState } from '../timer/pomo.js';
import { resetForUser as resetCustomForUser, customState } from '../timer/custom.js';
import { resetForUser as resetDictationForUser } from '../review/dictation.js';
import { resetForUser as resetQuizForUser } from '../review/quiz.js';

function hashPw(pw) {
  let h = 0xdeadbeef;
  const s = 'xxz_' + pw;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 2654435761);
    h = (h << 13) | (h >>> 19);
  }
  return 'h_' + (h >>> 0).toString(36);
}

function seedDefaultMetrics(userId) {
  const now = new Date().toISOString();
  const defaults = [
    { name: '体重', unit: 'kg', target_value: 65, target_dir: 'lower', pinned: true },
    { name: '身高', unit: 'cm', target_value: 0, target_dir: 'higher', pinned: false },
    { name: '睡眠时长', unit: '小时', target_value: 8, target_dir: 'higher', pinned: true },
    { name: '饮水量', unit: '升', target_value: 2, target_dir: 'higher', pinned: false },
    { name: '步数', unit: '步', target_value: 8000, target_dir: 'higher', pinned: false },
    { name: 'BMI', unit: '', target_value: 0, target_dir: 'lower', pinned: true, isDerived: true, formula: '体重 / (身高/100)^2' }
  ];
  for (const d of defaults) {
    DB.metrics.push({
      id: uid(),
      user_id: userId,
      name: d.name,
      unit: d.unit,
      target_value: d.target_value,
      target_dir: d.target_dir,
      pinned: !!d.pinned,
      isDerived: !!d.isDerived,
      formula: d.formula || '',
      createdAt: now
    });
  }
  save('metrics');
}

function clearAllOverlays() {
  ['reviewOverlay', 'dictationOverlay', 'quizOverlay', 'onboardingOverlay'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
}

let currentTab = 'login';

export function render() {
  const isLogin = currentTab === 'login';
  return `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-logo">
          <span class="logo-icon">🎯</span>
          <h1>生涯助手 4.0</h1>
          <p>规划人生 · 成就更好的自己</p>
        </div>
        <div class="auth-tabs">
          <button class="auth-tab${isLogin ? ' active' : ''}" data-action="auth-switch" data-tab="login" type="button">登录</button>
          <button class="auth-tab${!isLogin ? ' active' : ''}" data-action="auth-switch" data-tab="register" type="button">注册</button>
        </div>

        ${isLogin ? `
          <div class="auth-form">
            <div class="form-group">
              <label>用户名</label>
              <input type="text" id="loginUser" class="input" placeholder="请输入用户名" autocomplete="off">
            </div>
            <div class="form-group">
              <label>密码</label>
              <input type="password" id="loginPw" class="input" placeholder="请输入密码" autocomplete="off">
            </div>
            <button class="btn btn-primary" data-action="auth-login" type="button" style="width:100%;margin-top:8px;padding:12px">登 录</button>
            <div class="auth-error" id="authError"></div>
          </div>
        ` : `
          <div class="auth-form">
            <div class="form-group">
              <label>用户名</label>
              <input type="text" id="regUser" class="input" placeholder="3-20 个字符" autocomplete="off">
            </div>
            <div class="form-group">
              <label>密码</label>
              <input type="password" id="regPw" class="input" placeholder="至少 6 位" autocomplete="off">
            </div>
            <div class="form-group">
              <label>确认密码</label>
              <input type="password" id="regPw2" class="input" placeholder="再输入一次" autocomplete="off">
            </div>
            <div style="display:flex;gap:12px">
              <div class="form-group" style="flex:1">
                <label>体重(kg)</label>
                <input type="number" id="regWeight" class="input" placeholder="选填" step="0.1">
              </div>
              <div class="form-group" style="flex:1">
                <label>身高(cm)</label>
                <input type="number" id="regHeight" class="input" placeholder="选填" step="0.1">
              </div>
            </div>
            <div class="form-group">
              <label>城市</label>
              <input type="text" id="regCity" class="input" value="北京">
            </div>
            <button class="btn btn-primary" data-action="auth-register" type="button" style="width:100%;margin-top:8px;padding:12px">注 册</button>
            <div class="auth-error" id="authError"></div>
          </div>
        `}
      </div>
    </div>
  `;
}

function showError(msg) {
  const el = document.getElementById('authError');
  if (el) el.textContent = msg;
}

export const actions = {
  'auth-switch': (el) => {
    currentTab = el.dataset.tab;
    document.getElementById('app').innerHTML = render();
  },

  'auth-login': () => {
    const username = document.getElementById('loginUser').value.trim();
    const pw = document.getElementById('loginPw').value;
    if (!username || !pw) { showError('请填写完整'); return; }
    const user = DB.users.find(x => x.username === username);
    if (!user) { showError('用户名不存在'); return; }
    if (user.passwordHash !== hashPw(pw)) { showError('密码错误'); return; }

    resetUserScopedState();
    resetPomoForUser(null);
    resetCustomForUser(null);
    resetDictationForUser(null);
    resetQuizForUser(null);
    clearAllOverlays();

    State.user = user;
    /* ⭐ 加载该用户的 AI / 高德配置 */
    loadUserConfig(user.id);

    S.set('current_user_id', user.id);
    emit('auth:login', user);
  },

  'auth-register': () => {
    const username = document.getElementById('regUser').value.trim();
    const pw = document.getElementById('regPw').value;
    const pw2 = document.getElementById('regPw2').value;
    const weight = parseFloat(document.getElementById('regWeight').value) || 0;
    const height = parseFloat(document.getElementById('regHeight').value) || 0;
    const city = document.getElementById('regCity').value.trim() || '北京';

    if (!username || !pw) { showError('请填写用户名和密码'); return; }
    if (username.length < 3 || username.length > 20) { showError('用户名 3-20 字符'); return; }
    if (pw.length < 6) { showError('密码至少 6 位'); return; }
    if (pw !== pw2) { showError('两次密码不一致'); return; }
    if (DB.users.some(x => x.username === username)) { showError('用户名已存在'); return; }

    const user = {
      id: uid(),
      username,
      passwordHash: hashPw(pw),
      weight,
      height,
      gender: 'male',
      age: 0,
      city,
      semesterStart: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString()
    };
    DB.users.push(user);
    save('users');

    seedDefaultMetrics(user.id);

    const wMetric = DB.metrics.find(m => m.user_id === user.id && m.name === '体重');
    const hMetric = DB.metrics.find(m => m.user_id === user.id && m.name === '身高');
    const t = new Date().toISOString().slice(0, 10);
    if (weight > 0 && wMetric) {
      DB.metricValues.push({ id: uid(), metric_id: wMetric.id, date: t, value: weight, createdAt: new Date().toISOString() });
    }
    if (height > 0 && hMetric) {
      DB.metricValues.push({ id: uid(), metric_id: hMetric.id, date: t, value: height, createdAt: new Date().toISOString() });
    }
    save('metricValues');

    resetUserScopedState();
    resetPomoForUser(null);
    resetCustomForUser(null);
    resetDictationForUser(null);
    resetQuizForUser(null);
    clearAllOverlays();

    State.user = user;
    /* ⭐ 新用户没有配置，加载默认 */
    loadUserConfig(user.id);

    S.set('current_user_id', user.id);
    toast('注册成功，欢迎 ' + username, 'success');
    emit('auth:login', user);
  },

  'logout': () => {
    if (pomoState.interval) { clearInterval(pomoState.interval); pomoState.interval = null; }
    if (customState.interval) { clearInterval(customState.interval); customState.interval = null; }

    flush();

    const uidBefore = State.user ? State.user.id : null;

    resetUserScopedState();
    resetPomoForUser(null);
    resetCustomForUser(null);
    resetDictationForUser(null);
    resetQuizForUser(null);
    clearAllOverlays();
    /* ⭐ 清空内存中的用户配置（不删存储） */
    clearUserConfigInMemory();

    State.user = null;
    S.remove('current_user_id');
    if (uidBefore) S.remove('diaryDraft_' + uidBefore);

    document.getElementById('app').innerHTML = render();
    toast('已退出登录', 'success');
  }
};