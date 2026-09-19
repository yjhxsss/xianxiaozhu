import { SCHEMA_VERSION, STORAGE_PREFIX } from './version.js';

const S = {
  get(k, d = null) {
    try { const v = localStorage.getItem(STORAGE_PREFIX + k); return v ? JSON.parse(v) : d; }
    catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(STORAGE_PREFIX + k, JSON.stringify(v)); } catch {}
  },
  remove(k) {
    try { localStorage.removeItem(STORAGE_PREFIX + k); } catch {}
  }
};

export const DB = {
  users:        S.get('users', []),
  diaries:      S.get('diaries', []),
  moods:        S.get('moods', []),
  metrics:      S.get('metrics', []),
  metricValues: S.get('metricValues', []),
  todos:        S.get('todos', []),
  focusSessions:S.get('focusSessions', []),
  goals:        S.get('goals', []),
  habits:       S.get('habits', []),
  habitLogs:    S.get('habitLogs', []),
  courses:      S.get('courses', []),
  badges:       S.get('badges', []),
  settings:     S.get('settings', {}),
  decks:        S.get('decks', []),
  cards:        S.get('cards', []),
  reviewLogs:   S.get('reviewLogs', []),
  healthRecords:S.get('healthRecords', []),
  healthGoals:  S.get('healthGoals', [])
};

export const ENTITIES = [
  'users','diaries','moods','metrics','metricValues','todos','focusSessions',
  'goals','habits','habitLogs','courses','badges','settings',
  'decks','cards','reviewLogs','healthRecords','healthGoals'
];

/* ================================================================
 * ⭐ 模块分导出映射
 * ================================================================ */
export const MODULE_KEYS = {
  all: [
    'todos','diaries','moods','metrics','metricValues','focusSessions',
    'goals','habits','habitLogs','courses','badges','decks','cards','reviewLogs',
    'healthRecords','healthGoals'
  ],
  diary: ['diaries','moods','todos','focusSessions'],
  habitgoal: ['goals','habits','habitLogs','badges'],
  calsch: ['courses'],
  health: ['healthRecords','healthGoals'],
  review: ['decks','cards','reviewLogs'],
  metrics: ['metrics','metricValues']
};

export const USER_SCOPED_KEYS = [
  'todos','diaries','moods','metrics','focusSessions',
  'goals','habits','habitLogs','courses','badges',
  'decks','cards','reviewLogs','healthRecords','healthGoals'
];

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ⭐ 默认 AI 配置 */
const DEFAULT_AI_CONFIG = {
  endpoint: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  enabled: false,
  smartComplete: false,
  smartCompleteLimit: 20
};

export const State = {
  user: null,
  currentTab: S.get('current_tab', 'diary'),
  /* ⭐ 外观相关：全局（不随用户变） */
  theme: S.get('theme', 'dark'),
  accent: S.get('accent', 'violet'),
  /* ⭐ 用户级配置：登录时从 ai_config_<userId> 加载 */
  aiConfig: { ...DEFAULT_AI_CONFIG },
  amapKey: '',
  /* ===== */
  parseSourceId: null,
  parsedItems: [],
  aiSuggestions: null,
  aiLoading: false,
  weather: null,
  weatherLoading: false,
  weatherError: null,
  diaryDraft: '',
  selectedMood: null,
  selectedMoodTags: [],
  editingMoodId: null,
  metricCache: {},
  calDate: new Date(),
  calView: 'month',
  calSelected: new Date(),
  scheduleWeekOffset: 0,
  summaryRange: 'day',
  summaryStart: todayStr(),
  summaryEnd: todayStr(),
  viewMode: S.get('view_mode', { metrics: 'card' }),
  _currentSuggestions: [],
  doneExpanded: false,
  todosExpanded: false,
  moodsExpanded: false,
  suggestionsExpanded: false,
  calTodosExpanded: false,
  expandedGoalId: null,
  focusTag: '学习',
  lastBackupAt: S.get('last_backup_at', 0),
  lastSeenVersion: S.get('last_seen_version', ''),
  reviewDeckId: null,
  reviewSession: null,
  reviewView: 'main',
  cardSearchQuery: '',
  timer: {
    pomo:   { phase: null, running: false, seconds: 0, total: 0, startedAt: 0, elapsedAtStart: 0, interval: null },
    custom: { running: false, seconds: 0, total: 0, startedAt: 0, elapsedAtStart: 0, interval: null },
    work: S.get('timer_work', 25) * 60,
    break: S.get('timer_break', 5) * 60,
    autoCycle: S.get('timer_autoCycle', false),
    sound: S.get('timer_sound', true)
  }
};

State.timer.pomo.seconds = State.timer.work;
State.timer.pomo.total = State.timer.work;

/* ================================================================
 * ⭐ 用户级配置：AI / 高德 Key
 * ================================================================ */

/** 登录后调用：加载该用户的 AI / 高德配置 */
export function loadUserConfig(userId) {
  if (!userId) {
    State.aiConfig = { ...DEFAULT_AI_CONFIG };
    State.amapKey = '';
    return;
  }

  /* 迁移：老版全局 config → 当前用户 */
  const legacyAi = S.get('ai_config', null);
  const legacyAmap = S.get('amap_key', null);

  const aiKey = 'ai_config_' + userId;
  const amapKey = 'amap_key_' + userId;

  let ai = S.get(aiKey, null);
  if (!ai && legacyAi) {
    S.set(aiKey, legacyAi);
    S.remove('ai_config');
    ai = legacyAi;
  }

  let amap = S.get(amapKey, null);
  if (amap === null && legacyAmap) {
    S.set(amapKey, legacyAmap);
    S.remove('amap_key');
    amap = legacyAmap;
  }

  State.aiConfig = { ...DEFAULT_AI_CONFIG, ...(ai || {}) };
  State.amapKey = amap || '';
}

/** 保存当前用户配置（AI / 高德 Key） */
export function saveUserConfig() {
  const uid = State.user?.id;
  if (!uid) return;
  try {
    S.set('ai_config_' + uid, State.aiConfig);
    S.set('amap_key_' + uid, State.amapKey);
  } catch (e) {
    console.warn('[db] saveUserConfig failed:', e);
  }
}

/** 清空内存中的用户配置（不删存储） */
export function clearUserConfigInMemory() {
  State.aiConfig = { ...DEFAULT_AI_CONFIG };
  State.amapKey = '';
}

let _dataVersion = 0;
export function getDataVersion() { return _dataVersion; }
export function bumpDataVersion() { _dataVersion++; }

export function setLastBackupAt(ts) {
  State.lastBackupAt = ts || Date.now();
  S.set('last_backup_at', State.lastBackupAt);
}

export function setLastSeenVersion(v) {
  State.lastSeenVersion = v;
  S.set('last_seen_version', v);
}

export function resetUserScopedState() {
  State.parseSourceId = null;
  State.parsedItems = [];
  State.aiSuggestions = null;
  State.aiLoading = false;
  State.editingMoodId = null;
  State.expandedGoalId = null;
  State.doneExpanded = false;
  State.todosExpanded = false;
  State.moodsExpanded = false;
  State.suggestionsExpanded = false;
  State.calTodosExpanded = false;
  State.reviewDeckId = null;
  State.reviewSession = null;
  State.reviewView = 'main';
  State.cardSearchQuery = '';
  State.diaryDraft = '';
  State.selectedMood = null;
  State.selectedMoodTags = [];
  State.metricCache = {};
  State.calDate = new Date();
  State.calView = 'month';
  State.calSelected = new Date();
  State.scheduleWeekOffset = 0;
  State.summaryRange = 'day';
  State.summaryStart = todayStr();
  State.summaryEnd = todayStr();
  State.focusTag = '学习';
  State.weather = null;
  State.weatherLoading = false;
  State.weatherError = null;
  State._currentSuggestions = [];
  /* ⭐ 清空用户级配置 */
  State.aiConfig = { ...DEFAULT_AI_CONFIG };
  State.amapKey = '';
  if (State.timer.pomo.interval) { clearInterval(State.timer.pomo.interval); State.timer.pomo.interval = null; }
  if (State.timer.custom.interval) { clearInterval(State.timer.custom.interval); State.timer.custom.interval = null; }
  State.timer.pomo.running = false;
  State.timer.pomo.phase = null;
  State.timer.pomo.seconds = State.timer.work;
  State.timer.pomo.total = State.timer.work;
  State.timer.custom.running = false;
  State.timer.custom.seconds = 0;
  State.timer.custom.total = 0;
  _dataVersion++;
}

export function reloadFromStorage() {
  flush();
  ENTITIES.forEach(k => {
    if (k === 'settings') {
      DB[k] = S.get('settings', {});
    } else {
      DB[k] = S.get(k, []);
    }
  });
  _dataVersion++;
}

let saveTimer = null;
const dirty = new Set();

export function touch(...keys) {
  keys.forEach(k => dirty.add(k));
  _dataVersion++;
}

export function save(...keys) {
  if (keys.length) keys.forEach(k => dirty.add(k));
  else ENTITIES.forEach(k => dirty.add(k));
  _dataVersion++;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 150);
}

export function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  dirty.forEach(k => { if (k in DB) S.set(k, DB[k]); });
  dirty.clear();
}
export function isDirty() { return dirty.size > 0; }

window.addEventListener('beforeunload', flush);
window.addEventListener('pagehide', flush);

const undoStack = [];
const UNDO_MAX = 20;

export function snapshotDelete(key, id) {
  if (!Array.isArray(DB[key])) return null;
  const idx = DB[key].findIndex(x => x.id === id);
  if (idx < 0) return null;
  const item = JSON.parse(JSON.stringify(DB[key][idx]));
  undoStack.push({ key, item, idx, ts: Date.now() });
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  DB[key].splice(idx, 1);
  return item;
}

export function undo() {
  const last = undoStack.pop();
  if (!last) return false;
  const { key, item, idx } = last;
  if (!Array.isArray(DB[key])) DB[key] = [];
  if (!DB[key].some(x => x.id === item.id)) {
    const at = Math.min(Math.max(0, idx), DB[key].length);
    DB[key].splice(at, 0, item);
    save(key);
    flush();
  }
  return true;
}

export function hasUndo() { return undoStack.length > 0; }
export function clearUndo() { undoStack.length = 0; }

/* ================================================================
 * ⭐ 迁移框架
 * ================================================================ */

const MIGRATIONS = [
  {
    from: 1, to: 2, run(db) {
      if (Array.isArray(db.healthGoals)) {
        db.healthGoals.forEach(g => {
          if (typeof g.linkedType === 'undefined') g.linkedType = null;
          if (typeof g.linkedId === 'undefined') g.linkedId = null;
        });
      }
    }
  }
];

export function runMigrations() {
  const current = SCHEMA_VERSION;
  const stored = S.get('schema_version', current);

  if (stored === current) return;
  if (stored > current) {
    console.warn(`[db] 数据 schema v${stored} > 代码 v${current}，跳过迁移`);
    return;
  }

  for (const m of MIGRATIONS) {
    if (m.from >= stored && m.to <= current) {
      console.log(`[db] 迁移 v${m.from} → v${m.to}`);
      try { m.run(DB); }
      catch (e) { console.error(`[db] 迁移 v${m.from}→v${m.to} 失败:`, e); }
    }
  }

  S.set('schema_version', current);
  flush();
}

export function migrateUserData(userId) {
  if (!userId) return;
  let changed = false;

  const derived = DB.metrics.filter(m => m.user_id === userId && m.isDerived);
  for (const m of derived) {
    if (!m.formula) continue;
    if (/\bweight\b/.test(m.formula) || /\bheight\b/.test(m.formula)) {
      m.formula = m.formula
        .replace(/\bweight\b/g, '体重')
        .replace(/\bheight\b/g, '身高');
      changed = true;
    }
  }

  if (!Array.isArray(DB.healthGoals)) {
    DB.healthGoals = [];
    changed = true;
  }

  if (changed) {
    save('metrics', 'healthGoals');
    flush();
  }
}

/* ================================================================
 * 导出 / 导入
 * ================================================================ */

export function dumpUserData(userId) {
  flush();
  const data = {
    _app: '仙小助',
    _version: SCHEMA_VERSION,
    _exportedAt: new Date().toISOString(),
    _module: 'all'
  };
  const SCOPED = USER_SCOPED_KEYS;
  const ALL = MODULE_KEYS.all;
  ALL.forEach(k => {
    if (SCOPED.includes(k) && Array.isArray(DB[k])) {
      data[k] = DB[k].filter(item => !item.user_id || item.user_id === userId);
    } else {
      data[k] = DB[k];
    }
  });
  if (data.metrics) {
    const myMetricIds = new Set(data.metrics.map(m => m.id));
    if (data.metricValues) data.metricValues = data.metricValues.filter(v => myMetricIds.has(v.metric_id));
  }
  if (data.decks) {
    const myDeckIds = new Set(data.decks.map(d => d.id));
    if (data.cards) data.cards = data.cards.filter(c => myDeckIds.has(c.deck_id));
    if (data.reviewLogs) data.reviewLogs = data.reviewLogs.filter(l => myDeckIds.has(l.deck_id));
  }
  return data;
}

export function dumpModule(userId, moduleName) {
  flush();
  const keys = MODULE_KEYS[moduleName];
  if (!keys) throw new Error('未知模块：' + moduleName);

  const data = {
    _app: '仙小助',
    _version: SCHEMA_VERSION,
    _exportedAt: new Date().toISOString(),
    _module: moduleName
  };

  keys.forEach(k => {
    if (!Array.isArray(DB[k])) {
      data[k] = DB[k];
      return;
    }
    if (USER_SCOPED_KEYS.includes(k)) {
      data[k] = DB[k].filter(item => !item.user_id || item.user_id === userId);
    } else {
      data[k] = DB[k];
    }
  });

  if (data.metrics && !data.metricValues) {
    const ids = new Set(data.metrics.map(m => m.id));
    data.metricValues = DB.metricValues.filter(v => ids.has(v.metric_id));
  } else if (data.metrics && data.metricValues) {
    const ids = new Set(data.metrics.map(m => m.id));
    data.metricValues = data.metricValues.filter(v => ids.has(v.metric_id));
  }

  if (data.decks) {
    const ids = new Set(data.decks.map(d => d.id));
    if (data.cards) data.cards = data.cards.filter(c => ids.has(c.deck_id));
    if (data.reviewLogs) data.reviewLogs = data.reviewLogs.filter(l => ids.has(l.deck_id));
  }

  return data;
}

export function validateImportData(json) {
  const errors = [];
  if (!json || typeof json !== 'object') {
    return { ok: false, errors: ['不是有效的 JSON 对象'] };
  }
  if (json._app && json._app !== '仙小助') {
    errors.push(`文件来源不是仙小助（_app=${json._app}）`);
  }
  if (!json._version) {
    errors.push('缺少 _version 字段（旧版备份）');
  }
  if (json._version && json._version > SCHEMA_VERSION) {
    errors.push(`备份版本 v${json._version} 高于当前应用 v${SCHEMA_VERSION}，可能不兼容`);
  }
  const keys = Object.keys(json).filter(k => !k.startsWith('_'));
  if (!keys.length) {
    errors.push('文件里没有任何数据集合');
  }
  return { ok: errors.length === 0, errors };
}

export function previewImport(json, userId, strategy = 'merge') {
  const result = {
    willAdd: 0,
    willUpdate: 0,
    willSkip: 0,
    perKey: {},
    errors: []
  };

  const keys = Object.keys(json).filter(k => !k.startsWith('_'));

  keys.forEach(k => {
    const incoming = json[k];
    const detail = { add: 0, update: 0, skip: 0 };

    if (Array.isArray(incoming)) {
      if (!Array.isArray(DB[k])) DB[k] = [];
      const existingIds = new Set(DB[k].map(x => x.id).filter(Boolean));
      const incomingIds = new Set();
      incoming.forEach(item => {
        if (!item || !item.id) { detail.skip++; return; }
        if (incomingIds.has(item.id)) { detail.skip++; return; }
        incomingIds.add(item.id);
        if (existingIds.has(item.id)) {
          if (strategy === 'overwrite') detail.update++;
          else detail.skip++;
        } else {
          detail.add++;
        }
      });
    } else if (incoming && typeof incoming === 'object') {
      detail.add = Object.keys(incoming).length;
    }

    result.perKey[k] = detail;
    result.willAdd += detail.add;
    result.willUpdate += detail.update;
    result.willSkip += detail.skip;
  });

  return result;
}

export function autoBackupBeforeImport() {
  flush();
  const snapshot = {
    _autoBackupAt: new Date().toISOString(),
    data: {}
  };
  ENTITIES.forEach(k => {
    try { snapshot.data[k] = JSON.parse(JSON.stringify(DB[k])); } catch { snapshot.data[k] = DB[k]; }
  });
  try {
    S.set('backup_auto', snapshot);
    return true;
  } catch (e) {
    console.warn('[db] 自动备份失败:', e);
    return false;
  }
}

export function restoreAutoBackup() {
  const snap = S.get('backup_auto', null);
  if (!snap || !snap.data) return false;
  Object.keys(snap.data).forEach(k => {
    DB[k] = snap.data[k];
  });
  ENTITIES.forEach(k => save(k));
  flush();
  _dataVersion++;
  return true;
}

export function getAutoBackupInfo() {
  const snap = S.get('backup_auto', null);
  if (!snap) return null;
  return { at: snap._autoBackupAt };
}

export function importData(json, userId, strategy = 'merge') {
  const v = validateImportData(json);
  if (!v.ok) {
    throw new Error('数据校验失败：' + v.errors.join('；'));
  }

  const snapshot = {};
  ENTITIES.forEach(k => {
    try { snapshot[k] = JSON.parse(JSON.stringify(DB[k])); } catch { snapshot[k] = DB[k]; }
  });

  let added = 0;
  let updated = 0;
  let skipped = 0;

  try {
    const keys = Object.keys(json).filter(k => !k.startsWith('_'));

    keys.forEach(k => {
      const incoming = json[k];

      if (Array.isArray(incoming)) {
        if (!Array.isArray(DB[k])) DB[k] = [];

        const idxMap = new Map();
        DB[k].forEach((item, i) => { if (item && item.id) idxMap.set(item.id, i); });

        const seenInBatch = new Set();
        incoming.forEach(item => {
          if (!item || !item.id) { skipped++; return; }
          if (seenInBatch.has(item.id)) { skipped++; return; }
          seenInBatch.add(item.id);

          if (USER_SCOPED_KEYS.includes(k)) item.user_id = userId;

          if (idxMap.has(item.id)) {
            if (strategy === 'overwrite') {
              DB[k][idxMap.get(item.id)] = item;
              updated++;
            } else {
              skipped++;
            }
          } else {
            DB[k].push(item);
            idxMap.set(item.id, DB[k].length - 1);
            added++;
          }
        });
      } else if (incoming && typeof incoming === 'object') {
        DB[k] = { ...DB[k], ...incoming };
        updated++;
      }
    });

    ENTITIES.forEach(k => save(k));
    flush();
    _dataVersion++;

    return { ok: true, added, updated, skipped };

  } catch (e) {
    console.error('[db] 导入失败，回滚:', e);
    Object.keys(snapshot).forEach(k => { DB[k] = snapshot[k]; });
    _dataVersion++;
    return { ok: false, error: e.message, added: 0, updated: 0, skipped: 0 };
  }
}

export function countUserData(userId) {
  const cnt = k => Array.isArray(DB[k]) ? DB[k].filter(x => x.user_id === userId).length : 0;
  return {
    diaries: cnt('diaries'),
    todos: cnt('todos'),
    moods: cnt('moods'),
    metrics: cnt('metrics'),
    goals: cnt('goals'),
    habits: cnt('habits'),
    courses: cnt('courses'),
    focus: cnt('focusSessions'),
    decks: cnt('decks'),
    cards: cnt('cards'),
    health: cnt('healthRecords')
  };
}

try { runMigrations(); } catch (e) { console.warn('[db] migrations failed:', e); }

export { S };