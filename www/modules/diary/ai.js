import { DB, State, save, S } from '../../core/db.js';
import { esc, today, uid, clamp, fmtD, addDays, MOOD_SCORE } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';

const METRIC_DEFAULT_OP = {
  '饮水量': 'add', '学习时长': 'add', '运动时长': 'add', '步数': 'add',
  '阅读时长': 'add', '专注时长': 'add', '卡路里': 'add',
  '体重': 'set', '身高': 'set', 'BMI': 'set', '睡眠时长': 'set',
  '情绪评分': 'set', '血压': 'set', '血糖': 'set', '体温': 'set',
  '腰围': 'set', '胸围': 'set'
};

function resolveOpFallback(metricName, aiOp) {
  if (aiOp === 'add' || aiOp === 'sub' || aiOp === 'set') return aiOp;
  return METRIC_DEFAULT_OP[metricName] || 'set';
}

function convertUnitFallback(value, fromUnit, toUnit) {
  if (value == null || isNaN(value)) return value;
  const f = String(fromUnit || '').trim().toLowerCase();
  const t = String(toUnit || '').trim().toLowerCase();
  if (!f || !t || f === t) return value;
  const KG = ['kg', '公斤', '千克'];
  const L = ['l', '升'];
  const ML = ['ml', '毫升'];
  const HOUR = ['h', '小时'];
  const MIN = ['min', '分钟'];
  if (f === '斤' && KG.includes(t)) return value / 2;
  if (f === '两' && KG.includes(t)) return value / 20;
  if ((f === '克' || f === 'g') && KG.includes(t)) return value / 1000;
  if (KG.includes(f) && (t === '克' || t === 'g')) return value * 1000;
  if (KG.includes(f) && t === '斤') return value * 2;
  if (ML.includes(f) && L.includes(t)) return value / 1000;
  if (L.includes(f) && ML.includes(t)) return value * 1000;
  if (MIN.includes(f) && HOUR.includes(t)) return value / 60;
  if (HOUR.includes(f) && MIN.includes(t)) return value * 60;
  if ((f === '米' || f === 'm') && t === 'km') return value / 1000;
  if (t === '公里' && f === 'km') return value;
  if (f === '公里' && t === 'km') return value;
  return value;
}

function findMetricByName(name, userId) {
  const list = DB.metrics.filter(m => m.user_id === userId && !m.isDerived);
  if (!list.length) return null;
  const target = String(name || '').trim();
  if (!target) return null;
  let hit = list.find(m => m.name === target);
  if (hit) return hit;
  const norm = s => String(s).replace(/[\s()（）【】\[\]「」『』:：,，.。!！?？]/g, '').toLowerCase();
  const n = norm(target);
  if (!n) return null;
  hit = list.find(m => norm(m.name) === n);
  if (hit) return hit;
  if (n.length >= 2) {
    hit = list.find(m => {
      const mn = norm(m.name);
      return mn.length >= 2 && (mn.includes(n) || n.includes(mn));
    });
    if (hit) return hit;
  }
  return null;
}

function getTodayValue(mid) {
  const t = today();
  const ex = DB.metricValues.find(v => v.metric_id === mid && v.date === t && !v.sourceType);
  return ex ? ex.value : null;
}

/* ⭐ 根据 weekday 计算"最近的那个星期几"（今天优先） */
function calcDateFromWeekday(weekday) {
  /* weekday: 0=周日, 1-6=周一~周六 */
  const now = new Date();
  const todayDow = now.getDay();
  let diff = weekday - todayDow;
  if (diff < 0) diff += 7;
  const d = new Date(now);
  d.setDate(d.getDate() + diff);
  return d;
}

/* ⭐ 根据 daysFromNow 计算日期 */
function calcDateFromDays(dfn) {
  const d = new Date();
  d.setDate(d.getDate() + dfn);
  return d;
}

/* ⭐ 综合计算目标日期：优先 weekday，其次 daysFromNow，最后今天 */
function resolveTargetDate(raw) {
  if (Number.isInteger(raw.weekday) && raw.weekday >= 0 && raw.weekday <= 6) {
    return fmtD(calcDateFromWeekday(raw.weekday));
  }
  const dfn = Number.isInteger(raw.daysFromNow) ? raw.daysFromNow : (parseInt(raw.daysFromNow) || 0);
  if (dfn !== 0) return fmtD(calcDateFromDays(dfn));
  /* 都没有 → 今天 */
  return today();
}

const METRIC_RANGE = {
  '体重': [20, 300], '身高': [80, 250], 'BMI': [8, 80],
  '睡眠时长': [0, 24], '饮水量': [0, 20], '步数': [0, 100000],
  '学习时长': [0, 24], '运动时长': [0, 24], '专注时长': [0, 24],
  '情绪评分': [0, 10], '血压': [30, 300], '血糖': [0, 50],
  '体温': [30, 45], '腰围': [30, 200], '胸围': [30, 200]
};

const METRIC_DELTA_RANGE = {
  '体重': [0, 50], '身高': [0, 20], 'BMI': [0, 20],
  '睡眠时长': [0, 12], '饮水量': [0, 10], '步数': [0, 50000],
  '学习时长': [0, 12], '运动时长': [0, 12], '专注时长': [0, 12],
  '情绪评分': [0, 10], '血压': [0, 200], '血糖': [0, 30],
  '体温': [0, 10], '腰围': [0, 50], '胸围': [0, 50]
};

function isValueReasonable(name, value) {
  if (value == null || isNaN(value)) return false;
  const range = METRIC_RANGE[name];
  if (!range) return true;
  return value >= range[0] && value <= range[1];
}

function isDeltaReasonable(name, delta) {
  if (delta == null || isNaN(delta)) return false;
  const range = METRIC_DELTA_RANGE[name];
  if (!range) return true;
  return delta > 0 && delta <= range[1];
}

function guessTargetDir(name) {
  const n = String(name || '');
  const lower = ['体重', '腰围', '胸围', '血脂', '血糖', '血压', '体脂', '脂肪', '胆固醇', '心率'];
  for (const k of lower) if (n.includes(k)) return 'lower';
  return 'higher';
}

/* ============================================================
 * ⭐ AI 状态持久化
 * ============================================================ */

const _AI_STATE_PREFIX = 'ai_state_v2_';

let _persistTimer = null;

function _aiPersistKey(userId) {
  return _AI_STATE_PREFIX + (userId || 'guest');
}

export function persistAIState() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    if (!State.user) return;
    try {
      S.set(_aiPersistKey(State.user.id), {
        parsedItems: State.parsedItems || [],
        aiSuggestions: State.aiSuggestions || null,
        parseSourceId: State.parseSourceId || null,
        savedAt: Date.now()
      });
    } catch (e) {
      console.warn('[ai] persist 失败:', e);
    }
  }, 300);
}

export function persistAIStateNow() {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  if (!State.user) return;
  try {
    S.set(_aiPersistKey(State.user.id), {
      parsedItems: State.parsedItems || [],
      aiSuggestions: State.aiSuggestions || null,
      parseSourceId: State.parseSourceId || null,
      savedAt: Date.now()
    });
  } catch (e) {
    console.warn('[ai] persist 失败:', e);
  }
}

export function restoreAIState(userId) {
  if (!userId) return;
  const saved = S.get(_aiPersistKey(userId), null);
  if (!saved || typeof saved !== 'object') return;

  State.aiSuggestions = Array.isArray(saved.aiSuggestions) && saved.aiSuggestions.length
    ? saved.aiSuggestions
    : null;

  const sid = saved.parseSourceId || null;
  const diaryStillExists = sid && DB.diaries.find(d => d.id === sid && d.user_id === userId);
  if (diaryStillExists) {
    State.parseSourceId = sid;
    State.parsedItems = Array.isArray(saved.parsedItems) ? saved.parsedItems : [];
    State.parsedItems.forEach(it => {
      if (it && typeof it.editing !== 'boolean') it.editing = false;
    });
  } else {
    State.parseSourceId = null;
    State.parsedItems = [];
  }
}

export function clearPersistedAIState(userId) {
  if (userId) S.remove(_aiPersistKey(userId));
}

/* ============================================================
 * ⭐ 健康数据摘要
 * ============================================================ */

function buildHealthSummary() {
  const u = State.user;
  if (!u) return null;
  const uid = u.id;
  const t = today();

  const recs = (DB.healthRecords || []).filter(r => r.user_id === uid && r.date === t);

  const sleepSum = recs.filter(r => r.type === 'sleep').reduce((s, r) => s + (r.value || 0), 0);
  const waterSum = recs.filter(r => r.type === 'water').reduce((s, r) => s + (r.value || 0), 0);
  const exerciseMin = recs.filter(r => r.type === 'exercise').reduce((s, r) => s + (r.value || 0), 0);
  const calories = recs.filter(r => r.type === 'diet').reduce((s, r) => s + (r.calories || r.value || 0), 0);
  const protein = recs.filter(r => r.type === 'diet').reduce((s, r) => s + (parseFloat(r.protein) || 0), 0);
  const carb = recs.filter(r => r.type === 'diet').reduce((s, r) => s + (parseFloat(r.carb) || 0), 0);
  const fat = recs.filter(r => r.type === 'diet').reduce((s, r) => s + (parseFloat(r.fat) || 0), 0);
  const dietMeals = recs.filter(r => r.type === 'diet').map(r => ({
    meal: r.meal,
    foods: r.foods || [],
    calories: r.calories || 0,
    protein: r.protein || 0,
    carb: r.carb || 0,
    fat: r.fat || 0
  }));
  const exerciseItems = recs.filter(r => r.type === 'exercise').map(r => ({
    sport: r.sport,
    minutes: r.value,
    intensity: r.intensity
  }));

  const goals = (DB.healthGoals || []).filter(g => g.user_id === uid).map(g => ({
    type: g.type,
    target: g.target_value,
    unit: g.unit
  }));

  const last7 = [];
  for (let i = 0; i < 7; i++) {
    const d = fmtD(addDays(new Date(), -i));
    const dayRecs = (DB.healthRecords || []).filter(r => r.user_id === uid && r.date === d);
    last7.push({
      date: d,
      sleep: dayRecs.filter(r => r.type === 'sleep').reduce((s, r) => s + (r.value || 0), 0),
      water: dayRecs.filter(r => r.type === 'water').reduce((s, r) => s + (r.value || 0), 0),
      exercise: dayRecs.filter(r => r.type === 'exercise').reduce((s, r) => s + (r.value || 0), 0),
      calories: dayRecs.filter(r => r.type === 'diet').reduce((s, r) => s + (r.calories || r.value || 0), 0)
    });
  }
  const sum7 = last7.reduce((acc, d) => ({
    sleep: acc.sleep + d.sleep,
    water: acc.water + d.water,
    exercise: acc.exercise + d.exercise,
    calories: acc.calories + d.calories
  }), { sleep: 0, water: 0, exercise: 0, calories: 0 });

  return {
    today: {
      sleepHours: +sleepSum.toFixed(1),
      waterMl: waterSum,
      exerciseMin,
      calories,
      protein: +protein.toFixed(1),
      carb: +carb.toFixed(1),
      fat: +fat.toFixed(1),
      dietMeals,
      exerciseItems
    },
    week7Avg: {
      sleepHours: +(sum7.sleep / 7).toFixed(1),
      waterMl: Math.round(sum7.water / 7),
      exerciseMin: Math.round(sum7.exercise / 7),
      calories: Math.round(sum7.calories / 7)
    },
    goals
  };
}

/* ============================================================
 * 能量计算
 * ============================================================ */

const METS = {
  '跑步': { low: 6.0,  medium: 8.3,  high: 11.0 },
  '健身': { low: 3.5,  medium: 5.0,  high: 6.0 },
  '骑行': { low: 4.0,  medium: 8.0,  high: 10.0 },
  '游泳': { low: 4.5,  medium: 7.0,  high: 10.0 },
  '瑜伽': { low: 2.0,  medium: 2.5,  high: 4.0 },
  '球类': { low: 4.5,  medium: 7.0,  high: 10.0 },
  '散步': { low: 2.0,  medium: 3.5,  high: 5.0 },
  '其他': { low: 3.0,  medium: 4.5,  high: 6.0 }
};

function calcBMRForUser() {
  const u = State.user;
  if (!u) return 1400;
  const w = u.weight || 60;
  const h = u.height || 170;
  const a = u.age || 25;
  const g = u.gender || 'male';
  if (g === 'female') return Math.round(9.99 * w + 6.25 * h - 4.92 * a - 161);
  return Math.round(9.99 * w + 6.25 * h - 4.92 * a + 5);
}

function labelOfType(type) {
  return { water: '饮水', sleep: '睡眠', exercise: '运动', calories: '卡路里' }[type] || type;
}

function calcTodayEnergy() {
  const u = State.user;
  if (!u) return { intake: 0, exerciseKcal: 0, bmr: 1400, baseBurn: 1680, tef: 0, burned: 1680, net: -1680 };
  const uid = u.id;
  const t = today();
  const recs = (DB.healthRecords || []).filter(r => r.user_id === uid && r.date === t);

  const intake = recs.filter(r => r.type === 'diet').reduce((s, r) => s + (r.calories || r.value || 0), 0);

  const exerciseKcal = recs.filter(r => r.type === 'exercise').reduce((s, r) => {
    const w = u.weight || 60;
    const mins = r.value || 0;
    const sportMets = METS[r.sport] || METS['其他'];
    const mets = sportMets[r.intensity] || sportMets.medium;
    return s + Math.round((mets - 1) * w * (mins / 60));
  }, 0);

  const bmr = calcBMRForUser();
  const baseBurn = Math.round(bmr * 1.2);
  const tef = Math.round(intake * 0.10);
  const burned = baseBurn + exerciseKcal + tef;
  const net = intake - burned;

  return { intake, exerciseKcal, bmr, baseBurn, tef, burned, net };
}

/* ============================================================
 * ⭐ 解析 AI 返回的条目
 * ============================================================ */

function normalizeParseItem(raw, sourceText) {
  if (!raw || !raw.type) return null;
  let conf = ['high', 'mid', 'low'].includes(raw.confidence) ? raw.confidence : 'mid';

  /* ---- metric ---- */
  if (raw.type === 'metric') {
    let name = String(raw.metricName || '').trim() || '未知指标';
    const userId = State.user?.id;
    const matched = userId ? findMetricByName(name, userId) : null;

    let isNew = false;
    if (matched) {
      name = matched.name;
      if (conf === 'low') conf = 'mid';
    } else {
      const looksLikeMetric = raw.isNew === true || raw.isNew === 'true' || !!raw.unit;
      if (looksLikeMetric) { isNew = true; conf = 'mid'; }
      else { isNew = true; conf = 'low'; }
    }

    const op = resolveOpFallback(name, raw.op);

    let value = null;
    let valueSource = 'none';
    if (raw.value !== null && raw.value !== undefined && raw.value !== '' && !isNaN(parseFloat(raw.value))) {
      value = parseFloat(raw.value);
      valueSource = 'ai';
    }
    if (value === null && raw.rawValue != null && !isNaN(parseFloat(raw.rawValue))) {
      const rawV = parseFloat(raw.rawValue);
      const targetUnit = matched ? (matched.unit || '') : String(raw.unit || '');
      const rawU = String(raw.rawUnit || '').trim();
      if (rawU && targetUnit && rawU.toLowerCase() !== targetUnit.toLowerCase()) {
        value = convertUnitFallback(rawV, rawU, targetUnit);
        valueSource = 'local-convert';
      } else {
        value = rawV;
        valueSource = 'local-raw';
      }
    }
    if (value === null) {
      const localVal = extractLocalValue(name, sourceText);
      if (localVal != null) {
        value = localVal;
        valueSource = 'local-regex';
      }
    }

    if (value != null && value < 0) value = Math.abs(value);

    if (!isNew && value != null) {
      if (op === 'set') {
        if (!isValueReasonable(name, value)) conf = 'low';
      } else {
        if (!isDeltaReasonable(name, value)) conf = 'low';
      }
    }

    const targetUnit = matched ? (matched.unit || '') : String(raw.unit || '').trim();
    const rawUnit = String(raw.rawUnit || '').trim();

    return {
      id: uid(),
      type: 'metric',
      metricName: name,
      value: value,
      unit: targetUnit || rawUnit,
      rawValue: raw.rawValue != null ? parseFloat(raw.rawValue) : null,
      rawUnit: rawUnit,
      op: op,
      isNew: isNew,
      suggestedUnit: String(raw.unit || '').trim(),
      needsValue: value === null,
      confidence: conf,
      matched: !!matched,
      selected: value !== null && (conf !== 'low' || isNew),
      editing: false,
      date: today()
    };
  }

  /* ---- todo（带 repeat / priority / weekday）---- */
  if (raw.type === 'todo') {
    const t = String(raw.title || '').trim();
    if (!t) return null;
    const validRepeat = ['none', 'daily', 'weekly', 'monthly'].includes(raw.repeat) ? raw.repeat : 'none';
    const validPriority = ['high', 'medium', 'low'].includes(raw.priority) ? raw.priority : 'medium';

    /* ⭐ 日期计算：优先 weekday，其次 daysFromNow，最后今天 */
    let dateStr = today();
    let weekday = null;
    if (Number.isInteger(raw.weekday) && raw.weekday >= 0 && raw.weekday <= 6) {
      weekday = raw.weekday;
      dateStr = fmtD(calcDateFromWeekday(weekday));
    } else if (Number.isInteger(raw.daysFromNow) && raw.daysFromNow !== 0) {
      dateStr = fmtD(calcDateFromDays(raw.daysFromNow));
    }

    return {
      id: uid(),
      type: 'todo',
      title: t.slice(0, 60),
      repeat: validRepeat,
      priority: validPriority,
      weekday,
      confidence: conf,
      selected: true,
      editing: false,
      date: dateStr,
      goalId: null,
      goalContribution: 0
    };
  }

  /* ---- diet ---- */
  if (raw.type === 'diet') {
    const foods = Array.isArray(raw.foods)
      ? raw.foods.map(s => String(s).trim()).filter(Boolean).slice(0, 10)
      : [];
    const meal = ['breakfast', 'lunch', 'dinner', 'snack'].includes(raw.meal) ? raw.meal : 'lunch';
    const calories = parseInt(raw.calories) || 0;
    const protein = parseFloat(raw.protein) || 0;
    const carb = parseFloat(raw.carb) || 0;
    const fat = parseFloat(raw.fat) || 0;

    if (!foods.length) return null;

    return {
      id: uid(),
      type: 'diet',
      meal,
      foods,
      calories,
      protein,
      carb,
      fat,
      note: String(raw.note || '').slice(0, 80),
      confidence: conf,
      selected: true,
      editing: false,
      date: today()
    };
  }

  /* ---- exercise ---- */
  if (raw.type === 'exercise') {
    const sport = String(raw.sport || '其他').trim();
    const minutes = parseInt(raw.value) || parseInt(raw.minutes) || 0;
    const intensity = ['low', 'medium', 'high'].includes(raw.intensity) ? raw.intensity : 'medium';
    if (minutes <= 0) return null;

    return {
      id: uid(),
      type: 'exercise',
      sport: sport.slice(0, 20),
      value: minutes,
      intensity,
      note: String(raw.note || '').slice(0, 80),
      confidence: conf,
      selected: true,
      editing: false,
      date: today()
    };
  }

  return null;
}

function extractLocalValue(metricName, text) {
  const s = String(text || '');
  if (!metricName || !s) return null;
  const idx = s.indexOf(metricName);
  if (idx < 0) return null;
  const tail = s.slice(idx + metricName.length, idx + metricName.length + 30);
  const m = tail.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return isNaN(v) ? null : v;
}

/* ⭐ 本地识别星期几 */
function localFindWeekday(text) {
  const m = String(text).match(/(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/);
  if (!m) return null;
  const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0 };
  const v = map[m[1]];
  return v === undefined ? null : v;
}

function localParse(text) {
  const items = [];
  const userId = State.user?.id;
  const patterns = [
    { re: /体重[:：]?\s*(\d+\.?\d*)\s*(kg|公斤|斤)/i, name: '体重', unit: 'kg' },
    { re: /睡眠[:：]?\s*(\d+\.?\d*)\s*小时?/i, name: '睡眠时长', unit: '小时' },
    { re: /步数[:：]?\s*(\d{3,6})/i, name: '步数', unit: '步' },
    { re: /喝[了]?水[:：]?\s*(\d+\.?\d*)\s*(升|L|ml)/i, name: '饮水量', unit: '升' }
  ];
  patterns.forEach(p => {
    const m = text.match(p.re);
    if (m) {
      const matched = userId ? findMetricByName(p.name, userId) : null;
      const rawUnit = m[2] || p.unit;
      const targetUnit = matched ? (matched.unit || '') : p.unit;
      const converted = convertUnitFallback(parseFloat(m[1]), rawUnit, targetUnit);
      items.push({
        id: uid(),
        type: 'metric',
        metricName: matched ? matched.name : p.name,
        value: converted != null ? converted : parseFloat(m[1]),
        unit: targetUnit,
        rawValue: parseFloat(m[1]),
        rawUnit,
        op: METRIC_DEFAULT_OP[matched ? matched.name : p.name] || 'set',
        isNew: !matched,
        suggestedUnit: p.unit,
        needsValue: false,
        confidence: matched ? 'high' : 'mid',
        matched: !!matched,
        selected: true,
        editing: false,
        date: today()
      });
    }
  });

  const exPatterns = [
    { re: /(跑步|健身|骑行|游泳|瑜伽|散步)\s*(\d+)\s*分钟/i, sport: 1, value: 2 },
    { re: /(跑步|骑行|游泳)\s*(\d+(?:\.\d+)?)\s*公里/i, sport: 1, value: 'km' }
  ];
  for (const p of exPatterns) {
    const m = text.match(p.re);
    if (m) {
      if (p.value === 'km') {
        const km = parseFloat(m[2]);
        const minutes = Math.round(km * 6);
        items.push({
          id: uid(), type: 'exercise', sport: m[1], value: minutes,
          intensity: 'medium', note: `约 ${km} 公里`,
          confidence: 'mid', selected: true, editing: false, date: today()
        });
      } else {
        items.push({
          id: uid(), type: 'exercise', sport: m[1], value: parseInt(m[2]),
          intensity: 'medium', note: '',
          confidence: 'mid', selected: true, editing: false, date: today()
        });
      }
      break;
    }
  }

  text.split(/[。！？\n]+/).filter(s => s.trim().length > 5).forEach(s => {
    if (/明天|计划|记得|需要|每天|每周|每月|周[一二三四五六日天]/.test(s)) {
      let repeat = 'none';
      if (/每天|每日|天天/.test(s)) repeat = 'daily';
      else if (/每周|每星期|每礼拜|周[一二三四五六日天]/.test(s)) repeat = 'weekly';
      else if (/每月|每个月/.test(s)) repeat = 'monthly';

      let priority = 'medium';
      if (/重要|紧急|必须/.test(s)) priority = 'high';
      else if (/有空|顺便/.test(s)) priority = 'low';

      /* ⭐ 本地识别星期几 */
      const weekday = localFindWeekday(s);
      let dateStr = today();
      if (weekday !== null) {
        dateStr = fmtD(calcDateFromWeekday(weekday));
      }

      items.push({
        id: uid(), type: 'todo', title: s.trim().slice(0, 35),
        repeat, priority, weekday,
        confidence: 'mid', selected: true,
        editing: false, date: dateStr, goalId: null, goalContribution: 0
      });
    }
  });
  return items;
}

/* ============================================================
 * ⭐ AIHub 主体
 * ============================================================ */

export const AIHub = {
  isEnabled() {
    const c = State.aiConfig;
    return !!(c && c.enabled && c.apiKey && c.endpoint);
  },
  hint() {
    return this.isEnabled() ? '<span class="ai-badge">🤖 AI</span>' : '<span class="ai-badge local">本地建议</span>';
  },
  _url() {
    let ep = String(State.aiConfig.endpoint || '').trim().replace(/\/+$/, '');
    if (ep && !/\/chat\/completions$/.test(ep)) ep += '/chat/completions';
    return ep;
  },

  async chat(messages, opts = {}) {
    if (!this.isEnabled()) throw new Error('AI 未启用');
    const res = await fetch(this._url(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + State.aiConfig.apiKey
      },
      body: JSON.stringify({
        model: State.aiConfig.model || 'deepseek-chat',
        messages,
        temperature: opts.temperature != null ? opts.temperature : 0.4,
        max_tokens: opts.maxTokens || 2000
      })
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (e) {}
      throw new Error('HTTP ' + res.status + (body ? ' · ' + body.slice(0, 200) : ''));
    }
    const data = await res.json();
    const c = data.choices?.[0]?.message?.content;
    if (!c) throw new Error('空响应');
    return String(c).trim();
  },

  /* ============ 估算食物营养素 ============ */
  async estimateFoodNutrition(foodsText) {
    if (!this.isEnabled()) throw new Error('AI 未启用');
    const text = String(foodsText || '').trim();
    if (!text) throw new Error('食物为空');

    const prompt = `请估算下面食物的热量和三大营养素。严格返回 JSON 对象，不要任何其他文字或 markdown 标记。

食物：${text}

【要求】
1. 按常见份量估算（如一份、一碗、一个）
2. 如果有具体数量（如"两个鸡蛋"），按数量计算
3. calories 单位为 kcal（整数）
4. protein / carb / fat 单位为克（保留 1 位小数）

【输出格式】
{"calories":650,"protein":30.5,"carb":80.2,"fat":18.3}`;

    const res = await this.chat([
      { role: 'system', content: '你是营养师，只返回严格 JSON 对象。' },
      { role: 'user', content: prompt }
    ], { temperature: 0.2, maxTokens: 100 });

    let s = String(res).replace(/```json|```/g, '').trim();
    let obj;
    try { obj = JSON.parse(s); }
    catch {
      const m = s.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('AI 未返回 JSON');
      obj = JSON.parse(m[0]);
    }

    const calories = Math.round(parseFloat(obj.calories) || 0);
    const protein = +(parseFloat(obj.protein) || 0).toFixed(1);
    const carb = +(parseFloat(obj.carb) || 0).toFixed(1);
    const fat = +(parseFloat(obj.fat) || 0).toFixed(1);

    if (calories < 0 || calories > 10000) throw new Error('AI 估算热量异常');

    return { calories, protein, carb, fat };
  },

  async estimateFoodCalories(foodsText) {
    const r = await this.estimateFoodNutrition(foodsText);
    return r.calories;
  },

  /* ============ 生成个性化食谱 ============ */
  async generateMealPlan({ goal, profile, energy, nutrition }) {
    if (!this.isEnabled()) throw new Error('AI 未启用');

    const goalText = { cut: '减脂', maintain: '维持体重', bulk: '增肌' }[goal] || '维持体重';
    const p = profile || {};
    const e = energy || {};
    const n = nutrition || {};

    const netText = e.net > 0
      ? `盈余 ${e.net} kcal`
      : e.net < 0
        ? `赤字 ${Math.abs(e.net)} kcal`
        : '持平';

    const nutritionText = (n.protein > 0 || n.carb > 0 || n.fat > 0)
      ? `\n- 已摄入营养素：蛋白 ${n.protein.toFixed(1)}g / 碳水 ${n.carb.toFixed(1)}g / 脂肪 ${n.fat.toFixed(1)}g`
      : '';

    const prompt = `请根据以下信息，为用户生成一份详细的今日剩余食谱建议。

【用户画像】
- 性别：${p.gender === 'female' ? '女' : '男'}
- 年龄：${p.age || '未知'} 岁
- 身高：${p.height || '未知'} cm
- 体重：${p.weight || '未知'} kg
- 目的：${goalText}

【今日能量状态】
- 已摄入：${e.intake || 0} kcal
- 总消耗（基础+运动+TEF）：${e.burned || 0} kcal
- 净差：${netText}
- 基础代谢：${e.bmr || 0} kcal
- 运动消耗：${e.exerciseKcal || 0} kcal${nutritionText}

【要求】
1. 推荐一份**今日剩余时段**可以吃的食谱（早/午/晚/加餐，按当前时间合理分配）
2. 每道菜标注：名称 + 大致份量 + 热量（kcal）
3. 尽量让今日总蛋白质达到体重 × 1.2-1.6g（增肌可更高）
4. 给出今日总计的摄入目标（结合目的）
5. 给出 1-2 条饮食小贴士
6. 用简洁的中文，可以用 emoji 分段，但不要 markdown 语法（不要 ** ## 等）
7. 控制在 250 字以内`;

    return await this.chat([
      { role: 'system', content: '你是专业营养师，根据用户数据给出可执行的食谱建议。语言简洁口语化。' },
      { role: 'user', content: prompt }
    ], { temperature: 0.6, maxTokens: 800 });
  },

  /* ============ 周报 ============ */
  async generateWeeklyReport() {
    if (!this.isEnabled()) throw new Error('AI 未启用');
    const u = State.user;
    if (!u) throw new Error('未登录');
    const userId = u.id;
    const start = fmtD(addDays(new Date(), -6));
    const end = today();

    const diaries = DB.diaries.filter(d => d.user_id === userId && d.date >= start && d.date <= end);
    const todos = DB.todos.filter(x => x.user_id === userId && x.date >= start && x.date <= end);
    const moods = DB.moods.filter(m => m.user_id === userId && m.date >= start && m.date <= end);
    const sessions = DB.focusSessions.filter(f => f.user_id === userId && f.date >= start && f.date <= end);
    const habitLogs = DB.habitLogs.filter(l => l.user_id === userId && l.date >= start && l.date <= end);

    const moodCount = {};
    moods.forEach(m => { moodCount[m.mood] = (moodCount[m.mood] || 0) + 1; });
    const moodSummary = Object.keys(moodCount).map(k => `${k}×${moodCount[k]}`).join(' ');

    const h = buildHealthSummary();

    const prompt = `请根据以下数据，为我写一段 150-250 字的中文周报总结。

【周期】${start} ~ ${end}
【随笔数】${diaries.length} 条，共 ${diaries.reduce((s, d) => s + d.content.replace(/\s/g, '').length, 0)} 字
【随笔摘录】
${diaries.slice(-8).map(d => `- ${d.date}：${d.content.slice(0, 60)}`).join('\n') || '（无）'}
【待办】完成 ${todos.filter(t => t.completed).length}/${todos.length}
【专注时长】${sessions.reduce((s, f) => s + (f.duration_minutes || 0), 0)} 分钟，共 ${sessions.length} 段
【心情分布】${moodSummary || '（无）'}
【习惯打卡】${habitLogs.length} 次
${h ? `【健康】今日睡眠 ${h.today.sleepHours}h，饮水 ${h.today.waterMl}ml，运动 ${h.today.exerciseMin}分钟，摄入 ${h.today.calories}kcal
【近 7 天平均】睡眠 ${h.week7Avg.sleepHours}h，饮水 ${h.week7Avg.waterMl}ml，运动 ${h.week7Avg.exerciseMin}分钟，摄入 ${h.week7Avg.calories}kcal` : ''}

要求：
1. 用第一人称"我"，语气温和真诚
2. 指出这一周的高光点、可能的隐患、下周值得关注的方向
3. 不要罗列数据，而是整合成一段有洞察的叙述
4. 直接返回中文文本，不要 markdown 标记，不要标题`;

    return await this.chat([
      { role: 'system', content: '你是一个温和的成长教练，帮用户回顾一周，语言口语化，避免套话。' },
      { role: 'user', content: prompt }
    ], { temperature: 0.7, maxTokens: 800 });
  },

  /* ============ 健康周报 ============ */
  async generateHealthReport() {
    if (!this.isEnabled()) throw new Error('AI 未启用');
    const u = State.user;
    if (!u) throw new Error('未登录');
    const uid = u.id;

    const start = fmtD(addDays(new Date(), -6));
    const end = today();
    const recs = (DB.healthRecords || []).filter(r =>
      r.user_id === uid && r.date >= start && r.date <= end
    );

    const sleepRecs = recs.filter(r => r.type === 'sleep');
    const exRecs = recs.filter(r => r.type === 'exercise');
    const waterRecs = recs.filter(r => r.type === 'water');
    const dietRecs = recs.filter(r => r.type === 'diet');

    const sleepHours = +sleepRecs.reduce((s, r) => s + (r.value || 0), 0).toFixed(1);
    const sleepDays = new Set(sleepRecs.map(r => r.date)).size;
    const sleepAvg = sleepDays ? +(sleepHours / sleepDays).toFixed(1) : 0;
    const exerciseMin = exRecs.reduce((s, r) => s + (r.value || 0), 0);
    const waterMl = waterRecs.reduce((s, r) => s + (r.value || 0), 0);
    const calories = dietRecs.reduce((s, r) => s + (r.calories || r.value || 0), 0);
    const protein = +dietRecs.reduce((s, r) => s + (parseFloat(r.protein) || 0), 0).toFixed(1);
    const carb = +dietRecs.reduce((s, r) => s + (parseFloat(r.carb) || 0), 0).toFixed(1);
    const fat = +dietRecs.reduce((s, r) => s + (parseFloat(r.fat) || 0), 0).toFixed(1);

    const dayLines = [];
    for (let i = 6; i >= 0; i--) {
      const ds = fmtD(addDays(new Date(), -i));
      const day = recs.filter(r => r.date === ds);
      const sleep = day.filter(r => r.type === 'sleep').reduce((s, r) => s + (r.value || 0), 0);
      const ex = day.filter(r => r.type === 'exercise').reduce((s, r) => s + (r.value || 0), 0);
      const water = day.filter(r => r.type === 'water').reduce((s, r) => s + (r.value || 0), 0);
      const cal = day.filter(r => r.type === 'diet').reduce((s, r) => s + (r.calories || r.value || 0), 0);
      if (sleep || ex || water || cal) {
        dayLines.push(`${ds}：睡眠 ${sleep}h | 运动 ${ex}min | 饮水 ${water}ml | 摄入 ${cal}kcal`);
      }
    }

    const goals = (DB.healthGoals || []).filter(g => g.user_id === uid).map(g =>
      `${labelOfType(g.type)} 目标 ${g.target_value}${g.unit}`
    );

    const profile = {
      weight: u.weight || '未知',
      height: u.height || '未知',
      gender: u.gender === 'female' ? '女' : '男',
      age: u.age || '未知'
    };

    const bmr = calcBMRForUser();
    const baseBurn = Math.round(bmr * 1.2);

    const prompt = `请根据以下近 7 天的健康数据，为用户写一份 200-300 字的健康周报。

【周期】${start} ~ ${end}

【用户画像】
- 性别：${profile.gender} · 年龄：${profile.age} · 身高：${profile.height}cm · 体重：${profile.weight}kg

【本周汇总】
- 睡眠：总 ${sleepHours}h（${sleepDays} 天有记录，日均 ${sleepAvg}h）
- 运动：总 ${exerciseMin} 分钟，共 ${exRecs.length} 次
- 饮水：总 ${waterMl}ml，日均 ${Math.round(waterMl / 7)}ml
- 摄入：总 ${calories}kcal，日均 ${Math.round(calories / 7)}kcal
- 营养素：蛋白 ${protein}g / 碳水 ${carb}g / 脂肪 ${fat}g
- 基础代谢估算：${bmr} kcal/天，久坐基础消耗约 ${baseBurn} kcal/天

【每日明细】
${dayLines.length ? dayLines.join('\n') : '（本周无健康记录）'}

${goals.length ? `【健康目标】\n${goals.join('\n')}` : ''}

【要求】
1. 用第一人称"我"，语气温和真诚
2. 指出：本周亮点（做得好的）、可能的隐患（数据暴露的问题）、下周 1-2 个具体可执行的建议
3. 建议要具体（如"睡前 1 小时不看手机"而不是"早点睡"）
4. 不要罗列数据，而是整合成有洞察的叙述
5. 直接返回中文文本，不要 markdown 标记，不要标题
6. 控制在 300 字以内`;

    return await this.chat([
      { role: 'system', content: '你是一个温和的健康教练，根据数据给出具体可执行建议，避免套话。语言口语化。' },
      { role: 'user', content: prompt }
    ], { temperature: 0.7, maxTokens: 900 });
  },

  /* ============ ⭐ 拆解目标（带 repeat / weekday） ============ */
  async decomposeGoal(goal) {
    if (!this.isEnabled()) throw new Error('AI 未启用');
    if (!goal) throw new Error('无目标');

    const t = today();
    const dow = new Date().getDay();
    const weekday = '日一二三四五六'[dow];
    const existingTodos = DB.todos
      .filter(x => x.user_id === goal.user_id && x.goalId === goal.id && !x.completed)
      .map(x => x.title);

    let p = `请把下面这个目标拆解成 3-6 个具体的、可立即执行的小待办。

【今天日期】${t}（星期${weekday}，数字表示 ${dow}，周日=0）
【目标】${goal.title}
【类型】${goal.type === 'quant' ? `量化型（目标 ${goal.target_total || '?'} ${goal.unit || ''}）` : '手动型'}
【截止】${goal.deadline || '无'}`;

    if (goal.type === 'quant') {
      const total = (goal.records || []).reduce((s, r) => s + (parseFloat(r.value) || 0), 0);
      p += `\n【当前进度】${total} / ${goal.target_total} ${goal.unit}`;
    } else {
      p += `\n【当前进度】${goal.progress || 0}%`;
    }
    if (existingTodos.length) {
      p += `\n【已有待办（避免重复）】${existingTodos.join('、')}`;
    }

    p += `\n\n【要求】
1. 每条待办用**动词开头**，10-20 字，能立即执行
2. 每条待办包含以下字段：
   - title：待办标题
   - priority：high / medium / low
   - repeat：none / daily / weekly / monthly（描述"每天/每周/每月"→填对应值；否则 none）
   - **⚠️ daysFromNow 与 weekday 二选一（关键）**：
     * 如果待办是**具体星期几**（如"周三去健身房"）→ 填 weekday（0=周日，1=周一...6=周六），daysFromNow 填 null
     * 如果待办是**相对天数**（如"明天/后天"）→ 填 daysFromNow（0=今天，1=明天，2=后天），weekday 填 null
     * 如果都不明确 → daysFromNow 填 0，weekday 填 null
     * **不要"周三"的事情填 daysFromNow: 0（会落到今天）**
   - ${goal.type === 'quant' ? `contribution：这条待办完成后大约能给目标贡献多少 ${goal.unit}（可选，数字）` : 'contribution：0（手动型目标不需要）'}
3. 只返回 JSON 数组，不要任何 markdown 标记

【输出格式】
[
  {"title":"复习第一章","priority":"high","repeat":"none","weekday":null,"daysFromNow":0,${goal.type === 'quant' ? '"contribution":10' : '"contribution":0'}},
  {"title":"周三去健身房","priority":"high","repeat":"weekly","weekday":3,"daysFromNow":null,"contribution":0},
  {"title":"每天背单词","priority":"medium","repeat":"daily","weekday":null,"daysFromNow":0,"contribution":0},
  {"title":"明天做一套真题","priority":"high","repeat":"none","weekday":null,"daysFromNow":1,${goal.type === 'quant' ? '"contribution":30' : '"contribution":0'}}
]`;

    const text = await this.chat([
      { role: 'system', content: '你是一个任务拆解专家，只输出严格 JSON 数组，不要 markdown 标记。' },
      { role: 'user', content: p }
    ], { temperature: 0.5, maxTokens: 1200 });

    let s = text.replace(/```json|```/g, '').trim();
    let arr;
    try { arr = JSON.parse(s); }
    catch {
      const m = s.match(/\[[\s\S]*\]/);
      if (!m) throw new Error('AI 返回格式错误');
      arr = JSON.parse(m[0]);
    }
    if (!Array.isArray(arr)) throw new Error('AI 返回格式错误');

    return arr
      .filter(x => x && x.title)
      .slice(0, 8)
      .map(x => {
        /* ⭐ 日期计算：优先 weekday，其次 daysFromNow */
        let dateStr = today();
        let weekdayVal = null;
        if (Number.isInteger(x.weekday) && x.weekday >= 0 && x.weekday <= 6) {
          weekdayVal = x.weekday;
          dateStr = fmtD(calcDateFromWeekday(weekdayVal));
        } else {
          const dfn = Number.isInteger(x.daysFromNow) ? x.daysFromNow : (parseInt(x.daysFromNow) || 0);
          if (dfn !== 0) dateStr = fmtD(calcDateFromDays(dfn));
        }

        return {
          title: String(x.title).slice(0, 60),
          priority: ['high', 'medium', 'low'].includes(x.priority) ? x.priority : 'medium',
          repeat: ['none', 'daily', 'weekly', 'monthly'].includes(x.repeat) ? x.repeat : 'none',
          weekday: weekdayVal,
          daysFromNow: Number.isInteger(x.daysFromNow) ? x.daysFromNow : (parseInt(x.daysFromNow) || 0),
          date: dateStr,
          contribution: parseFloat(x.contribution) || 0
        };
      });
  },

  async analyzeMood() {
    if (!this.isEnabled()) throw new Error('AI 未启用');
    const u = State.user;
    if (!u) throw new Error('未登录');
    const userId = u.id;
    const start = fmtD(addDays(new Date(), -6));
    const end = today();

    const moods = DB.moods.filter(m => m.user_id === userId && m.date >= start && m.date <= end);
    if (moods.length < 3) throw new Error('近 7 天记录少于 3 条，无法分析');

    const lines = moods
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(m => {
        const tags = (m.tags || []).join('/');
        const trigger = m.trigger ? ` 因为「${m.trigger}」` : '';
        return `${m.date} ${m.mood}${tags ? ' [' + tags + ']' : ''}${trigger}`;
      }).join('\n');

    const prompt = `请根据以下心情记录，为用户写一段 100-200 字的情绪分析。

【周期】${start} ~ ${end}（共 ${moods.length} 条记录）
【记录】
${lines}

要求：
1. 指出情绪的主要波动规律（比如周中低落、周末好转）
2. 尝试归因：什么事件/标签跟高/低情绪相关
3. 给出 1-2 条可行的、温和的调节建议
4. 用第二人称"你"，语气平和，不评判
5. 直接返回中文，不要 markdown 标记，不要标题`;

    return await this.chat([
      { role: 'system', content: '你是一个善于观察的情绪分析师，说话温和、具体、不空泛。' },
      { role: 'user', content: prompt }
    ], { temperature: 0.6, maxTokens: 800 });
  },

  async completeText(partial) {
    if (!this.isEnabled()) throw new Error('AI 未启用');
    const u = State.user;
    if (!u) throw new Error('未登录');
    const userId = u.id;
    const t = today();

    const recent = DB.diaries
      .filter(d => d.user_id === userId && d.date === t)
      .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
      .slice(0, 3)
      .map(d => d.content.slice(0, 100));

    const prompt = `用户正在写日记，请续写一句话。

【今天其他记录】
${recent.join('\n') || '（无）'}

【用户已写】
${partial}

要求：
1. 直接续写，不要重复用户已写的内容
2. 20-50 字，自然衔接，不要用"然后""接下来"等词开头
3. 只返回续写的文字，不要任何解释、标点前缀或 markdown`;

    return await this.chat([
      { role: 'system', content: '你是用户的日记助手，帮助续写但保留用户自己的语气。' },
      { role: 'user', content: prompt }
    ], { temperature: 0.7, maxTokens: 200 });
  },

  async generateSuggestions() {
    if (!this.isEnabled()) throw new Error('AI 未启用');
    const u = State.user;
    if (!u) throw new Error('未登录');
    const userId = u.id;
    const t = today();

    const profile = { username: u.username, gender: u.gender, age: u.age, city: u.city, weight: u.weight, height: u.height };
    const weather = State.weather ? { city: State.weather.city, temp: State.weather.temp, desc: State.weather.desc } : null;
    const todayMoods = DB.moods.filter(m => m.user_id === userId && m.date === t).map(m => m.mood);
    const todayDiaries = DB.diaries.filter(d => d.user_id === userId && d.date === t).map(d => d.content.slice(0, 100));
    const todayTodos = DB.todos.filter(x => x.user_id === userId && x.date === t).map(x => ({ title: x.title, done: x.completed, time: x.time }));
    const undoneCount = todayTodos.filter(x => !x.done).length;
    const goalsActive = DB.goals.filter(g => g.user_id === userId && !g.completed).map(g => g.title);
    const habitsCount = DB.habits.filter(h => h.user_id === userId).length;
    const todayFocus = DB.focusSessions.filter(f => f.user_id === userId && f.date === t).reduce((s, f) => s + (f.duration_minutes || 0), 0);

    const h = buildHealthSummary();

    const prompt = `请基于以下数据，为用户生成 3-6 条今日个性化建议。

【用户画像】${JSON.stringify(profile)}
【今日天气】${weather ? JSON.stringify(weather) : '无'}
【今日心情】${JSON.stringify(todayMoods)}
【今日随笔】${todayDiaries.join(' | ') || '无'}
【今日待办】未完成 ${undoneCount} 项 · 共 ${todayTodos.length} 项
【活跃目标】${JSON.stringify(goalsActive)}
【习惯数】${habitsCount} 个
【今日专注】${todayFocus} 分钟
${h ? `【今日健康】
- 睡眠：${h.today.sleepHours} 小时（近 7 天平均 ${h.week7Avg.sleepHours}）
- 饮水：${h.today.waterMl} ml
- 运动：${h.today.exerciseMin} 分钟
- 摄入：${h.today.calories} kcal
- 营养素：蛋白 ${h.today.protein}g / 碳水 ${h.today.carb}g / 脂肪 ${h.today.fat}g
- 今日饮食记录：${h.today.dietMeals.map(m => `${m.meal}:${m.foods.join('、')}`).join('；') || '无'}
【健康目标】${h.goals.map(g => `${g.type} ${g.target}${g.unit}`).join('、') || '未设置'}` : ''}

要求：
1. 3-6 条，按重要性排序
2. 每条 20 字以内，具体、可执行
3. 结合数据，不要泛泛而谈
4. **如果建议可以落地为具体行动**，带上 action 字段：
   - 采纳为待办：{"kind": "todo", "title": "行动标题（15字内）"}
   - 采纳为目标：{"kind": "goal", "title": "目标名称", "type": "manual", "target_total": 0, "unit": ""}
   （如果建议只是"提醒/提醒天气/一般性建议"，不要带 action）
5. 只返回 JSON 数组：
[{"icon":"emoji","text":"建议内容","type":"weather|todo|profile|health|study|time","action":{...可选}}]
6. 不要任何 markdown 标记`;

    const text = await this.chat([
      { role: 'system', content: '你是一个生活助手，只输出严格 JSON 数组。' },
      { role: 'user', content: prompt }
    ], { temperature: 0.6, maxTokens: 800 });

    let s = text.replace(/```json|```/g, '').trim();
    let arr;
    try { arr = JSON.parse(s); }
    catch {
      const m = s.match(/\[[\s\S]*\]/);
      if (!m) throw new Error('AI 返回格式错误');
      arr = JSON.parse(m[0]);
    }
    if (!Array.isArray(arr)) throw new Error('AI 返回格式错误');

    return arr
      .filter(x => x && x.text)
      .slice(0, 8)
      .map(x => {
        const item = {
          icon: x.icon || '💡',
          text: String(x.text).slice(0, 60),
          type: x.type || 'time'
        };
        if (x.action && x.action.kind) {
          if (x.action.kind === 'todo' && x.action.title) {
            item.action = { kind: 'todo', title: String(x.action.title).slice(0, 40) };
          } else if (x.action.kind === 'goal' && x.action.title) {
            item.action = {
              kind: 'goal',
              title: String(x.action.title).slice(0, 40),
              type: x.action.type === 'quant' ? 'quant' : 'manual',
              target_total: parseFloat(x.action.target_total) || 0,
              unit: String(x.action.unit || '').slice(0, 10)
            };
          }
        }
        return item;
      });
  },

  buildContext(includeParse) {
    const u = State.user;
    if (!u) return null;
    const userId = u.id, t = today();
    const ctx = {
      profile: { username: u.username, gender: u.gender, age: u.age, city: u.city, weight: u.weight, height: u.height },
      weather: State.weather ? { city: State.weather.city, temp: State.weather.temp, desc: State.weather.desc } : null,
      today: {
        mood: DB.moods.filter(m => m.user_id === userId && m.date === t).map(m => m.mood),
        diaries: DB.diaries.filter(d => d.user_id === userId && d.date === t).map(d => d.content.slice(0, 100)),
        todos: DB.todos.filter(x => x.user_id === userId && x.date === t).map(x => ({ title: x.title, done: x.completed, time: x.time }))
      },
      health: buildHealthSummary()
    };
    if (includeParse) {
      ctx.parse_context = {
        metrics: DB.metrics
          .filter(m => m.user_id === userId && !m.isDerived)
          .map(m => ({ name: m.name, unit: m.unit || '' })),
        goals: DB.goals.filter(g => g.user_id === userId).map(g => ({ id: g.id, title: g.title, type: g.type }))
      };
    }
    return ctx;
  },

  buildPrompt(text, ctx) {
    const hasText = !!(text && text.trim());
    const metricNames = (ctx.parse_context && ctx.parse_context.metrics || []).map(m => m.name);
    const dow = new Date().getDay();
    const dowCn = '日一二三四五六'[dow];

    let p = '你是一个生涯规划助手，需要基于用户数据返回严格合法的 JSON 对象。\n\n';

    p += '=== 【上下文数据】仅供生成 suggestions，请勿从中提取 metric / todo ===\n';
    p += '【今天】' + today() + '（星期' + dowCn + '，数字 ' + dow + '）\n';
    p += '【用户画像】' + JSON.stringify(ctx.profile) + '\n';
    p += '【今日天气】' + (ctx.weather ? JSON.stringify(ctx.weather) : '无') + '\n';
    p += '【今日心情】' + JSON.stringify(ctx.today.mood) + '\n';
    p += '【今日随笔列表】' + (ctx.today.diaries.join(' | ') || '无') + '\n';
    p += '【今日待办】' + JSON.stringify(ctx.today.todos) + '\n';
    if (ctx.health) {
      p += '【今日健康】睡眠 ' + ctx.health.today.sleepHours + 'h，饮水 ' + ctx.health.today.waterMl + 'ml，运动 ' + ctx.health.today.exerciseMin + '分钟，摄入 ' + ctx.health.today.calories + 'kcal\n';
    }
    p += '\n';

    if (hasText) {
      p += '=== 【解析目标】只有这一条随笔需要被解析成 metric / todo / diet / exercise ===\n';
      p += '"""\n' + text + '\n"""\n\n';

      p += '【用户已有的指标（含单位）】\n';
      p += JSON.stringify(ctx.parse_context.metrics) + '\n\n';
      p += '【用户已有的目标】' + JSON.stringify(ctx.parse_context.goals) + '\n\n';

      p += '=== 解析规则 ===\n\n';

      p += '【⚠️ 铁律 0：解析来源】\n';
      p += '**只解析上方「解析目标」字段里的那条随笔**。\n';
      p += '- 「今日随笔列表」只是背景，不要从中提取任何项\n';
      p += '- 如果「解析目标」里没有提到某件事，就不要生成对应的解析项\n\n';

      p += '【规则 1：metricName】\n';
      p += 'a) 优先匹配已有指标（逐字复制 name）。\n';
      p += 'b) 允许生成新指标：明确的、可量化、可重复记录的东西。\n\n';

      p += '【规则 2：什么时候不生成 metric】\n';
      p += '一次性事件（"吃了个包子"）、主观感受没量化（"心情不错"）、纯动作（"去了图书馆"）→ 不生成 metric。\n\n';

      p += '【规则 3：value 换算到目标单位】\n';
      p += '"体重长了5斤"（目标 kg）→ value=2.5。同时填 rawValue / rawUnit。\n\n';

      p += '【规则 4：op 由语义决定】\n';
      p += 'set：陈述当前值。add：描述增量。sub：描述减量。\n';
      p += 'value 必须是正数，方向由 op 决定。\n\n';

      p += '【规则 5：confidence】\n';
      p += 'high / mid / low。表达清晰→high；有一点不确定→mid；把握不大→low。\n\n';

      p += '【规则 6：⭐ 饮食 / 运动特别处理】\n';
      p += '如果随笔描述了**吃了什么**，生成 diet 项（含营养素估算）：\n';
      p += '{"type":"diet","meal":"breakfast|lunch|dinner|snack","foods":["食物1","食物2"],"calories":650,"protein":30,"carb":80,"fat":18,"confidence":"high"}\n';
      p += '- meal：根据上下文或时间判断，不确定填 lunch\n';
      p += '- calories：按常见份量估算总热量（整数 kcal）\n';
      p += '- protein / carb / fat：估算三大营养素克数（保留 1 位小数）\n\n';
      p += '如果随笔描述了**做了什么运动**，生成 exercise 项：\n';
      p += '{"type":"exercise","sport":"跑步|健身|骑行|游泳|瑜伽|球类|散步|其他","value":分钟数,"intensity":"low|medium|high","note":"可选备注","confidence":"high"}\n';
      p += '- value 单位是分钟，"跑了5公里"按每公里 6 分钟估算为 30 分钟\n\n';

      p += '【规则 7：⭐ 待办特别处理（关键）】\n';
      p += '如果随笔描述了**要做的事情**，生成 todo 项：\n';
      p += '{"type":"todo","title":"待办内容","repeat":"none|daily|weekly|monthly","priority":"high|medium|low","weekday":null,"daysFromNow":0,"confidence":"high"}\n';
      p += '- repeat：描述"每天/每周/每月/天天" → 填对应值；否则 none\n';
      p += '- priority：描述"重要/紧急/必须" → high；"有空/顺便" → low；其他 → medium\n';
      p += '- **⚠️ weekday 与 daysFromNow 二选一（关键）**：\n';
      p += '  * 如果待办是**具体星期几**（如"周三去健身房"）→ 填 weekday（0=周日，1=周一...6=周六），daysFromNow 填 0\n';
      p += '  * 如果待办是**相对天数**（如"明天/后天"）→ 填 daysFromNow（0=今天，1=明天，2=后天），weekday 填 null\n';
      p += '  * 如果都不明确 → daysFromNow 填 0，weekday 填 null\n';
      p += '  * **不要"周三"的事情填 weekday=null（会落到今天）**\n\n';

      p += '【规则 8：json 结构（metric）】\n';
      p += '{"type":"metric","metricName":"体重","value":2.5,"rawValue":5,"rawUnit":"斤","unit":"kg","op":"add","isNew":false,"confidence":"high"}\n\n';
    }

    p += '【输出格式】严格返回 JSON 对象：\n';
    p += '{\n  "suggestions": [{"icon":"emoji","text":"20字内建议","type":"weather|todo|profile|health|study|time","action":{可选}}]\n';
    if (hasText) {
      p += ',\n  "parsed": [ ... 从「解析目标」提取的 metric / todo / diet / exercise ... ]\n';
      p += '\n  // todo 结构：{"type":"todo","title":"待办内容","repeat":"none|daily|weekly|monthly","priority":"high|medium|low","weekday":null,"daysFromNow":0,"confidence":"high|mid|low"}\n';
      p += '\n  // ⚠️ parsed 数组只能来自「解析目标」那一条随笔，如果那条随笔没有可解析内容，parsed 返回 []\n';
    }
    p += '}\n\n';
    p += '【suggestion.action 字段（可选）】\n';
    p += '- 当建议可落地为具体待办/目标时提供\n';
    p += '- 待办：{"kind":"todo","title":"行动标题(15字内)"}\n';
    p += '- 目标：{"kind":"goal","title":"目标名称","type":"manual","target_total":0,"unit":""}\n';
    p += '- 一般性建议（天气、时段问候）不要带 action\n\n';
    p += '要求：3-5 条建议，按重要性排序。只返回 JSON，不要 markdown 标记。';

    if (hasText && metricNames.length) {
      p += `\n\n【已有指标名（优先匹配这些）】${metricNames.join('、')}`;
    }

    return p;
  },

  async run() {
    const sel = State.parseSourceId ? DB.diaries.find(d => d.id === State.parseSourceId) : null;
    const text = sel ? sel.content : '';

    if (!this.isEnabled()) {
      State.aiSuggestions = null;
      if (sel) State.parsedItems = localParse(text);
      persistAIStateNow();
      rerender();
      toast('已刷新本地' + (sel ? '建议 + 解析' : '建议'), 'success');
      return;
    }

    State.aiLoading = true;
    rerender();

    try {
      const ctx = this.buildContext(!!text);
      const prompt = this.buildPrompt(text, ctx);
      const res = await fetch(this._url(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + State.aiConfig.apiKey },
        body: JSON.stringify({
          model: State.aiConfig.model || 'deepseek-chat',
          messages: [
            { role: 'system', content: '你是一个结构化输出助手，只输出严格合法的 JSON，不要任何其他文字或 markdown 标记。' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.2,
          max_tokens: 2500
        })
      });
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch (e) {}
        throw new Error('HTTP ' + res.status + (body ? ' · ' + body.slice(0, 200) : ''));
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('空响应');
      let s = String(content).replace(/```json|```/g, '').trim();
      let obj;
      try { obj = JSON.parse(s); }
      catch (e) {
        const m = s.match(/\{[\s\S]*\}/);
        if (m) {
          try { obj = JSON.parse(m[0]); }
          catch (e2) { throw new Error('AI 返回的 JSON 无法解析'); }
        } else {
          throw new Error('AI 未返回 JSON');
        }
      }

      State.aiSuggestions = Array.isArray(obj.suggestions) ? obj.suggestions.slice(0, 8).map(x => {
        const item = {
          icon: x.icon || '💡',
          text: String(x.text || '').slice(0, 60),
          type: x.type || 'time'
        };
        if (x.action && x.action.kind) {
          if (x.action.kind === 'todo' && x.action.title) {
            item.action = { kind: 'todo', title: String(x.action.title).slice(0, 40) };
          } else if (x.action.kind === 'goal' && x.action.title) {
            item.action = {
              kind: 'goal',
              title: String(x.action.title).slice(0, 40),
              type: x.action.type === 'quant' ? 'quant' : 'manual',
              target_total: parseFloat(x.action.target_total) || 0,
              unit: String(x.action.unit || '').slice(0, 10)
            };
          }
        }
        return item;
      }) : null;

      State.parsedItems = (!!text ? (obj.parsed || []) : []).map((raw) => normalizeParseItem(raw, text)).filter(Boolean);
      persistAIStateNow();
      toast('已生成', 'success');
    } catch (e) {
      console.warn('[AIHub.run 失败]', e);
      const msg = (e && e.message) ? e.message : String(e);
      toast('AI 调用失败：' + msg, 'error', { duration: 8000 });
    } finally {
      State.aiLoading = false;
      rerender();
    }
  }
};

/* ============================================================
 * 渲染面板
 * ============================================================ */

export function renderPanel(sel) {
  const suggestions = State.aiSuggestions && State.aiSuggestions.length ? State.aiSuggestions : localSuggestions();
  const selPreview = sel
    ? esc(sel.content.slice(0, 40)) + (sel.content.length > 40 ? '...' : '')
    : '<span style="color:var(--text-muted)">未选中随笔（仅生成建议）</span>';

  const undoneCount = DB.todos.filter(x => x.user_id === State.user.id && x.date === today() && !x.completed).length;
  const goalsActive = DB.goals.filter(x => x.user_id === State.user.id && !x.completed).length;

  const expanded = !!State.suggestionsExpanded;
  const shownSuggestions = expanded ? suggestions : suggestions.slice(0, 3);

  let html = `
    <div class="panel" id="aiAssistantPanel">
      <div class="panel-title">
        <span class="title-icon">💡</span>AI 助手
        ${AIHub.hint()}
        <div class="ai-title-actions">
          <button class="btn btn-sm btn-ghost" data-action="ai-refresh-suggestions" type="button"
                  title="仅刷新建议，不重新解析随笔（省 token）">
            🔄 刷新建议
          </button>
          <button class="btn btn-sm btn-primary" data-action="ai-refresh" type="button"
                  title="重新生成建议并解析选中的随笔">
            ✨ 生成建议${sel ? ' + 解析' : ''}
          </button>
        </div>
      </div>
      <div class="ai-context-summary">
        <div class="ai-context-item"><span class="ai-context-label">📝 当前随笔</span><span class="ai-context-value">${selPreview}</span></div>
        <div class="ai-context-item"><span class="ai-context-label">📊 今日数据</span><span class="ai-context-value">待办 ${undoneCount} · 目标 ${goalsActive}</span></div>
      </div>`;

  if (State.aiLoading) {
    html += `<div class="ai-section"><div class="ai-section-title">💡 今日建议</div><div class="ai-loading">🤖 AI 生成中...</div></div>`;
    html += '</div>';
    return html;
  }

  let suggestionsHtml = renderSuggestions(shownSuggestions, 'main');
  if (suggestions.length > 3) {
    suggestionsHtml += `<button class="btn btn-xs btn-ghost expand-btn" data-action="toggle-suggestions-expand" type="button">
      ${expanded ? '收起 ▲' : `展开全部 ${suggestions.length} 条 ▼`}
    </button>`;
  }
  html += `<div class="ai-section"><div class="ai-section-title">💡 今日建议</div>${suggestionsHtml}</div>`;

  if (sel) {
    html += `<div class="ai-section"><div class="ai-section-title">📜 从随笔解析</div>`;
    if (!State.parsedItems.length) {
      html += '<div class="done-empty" style="padding:12px;font-size:11.5px">点右上角「✨ 生成建议 + 解析」同时生成建议并解析随笔</div>';
    } else {
      html += State.parsedItems.map(renderParseItem).join('');
      html += '<div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-sm btn-primary" data-action="parse-confirm-all" type="button" style="flex:1">✅ 确认选中</button></div>';
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function renderSuggestions(list, listKey = 'main') {
  if (!list.length) return '<div class="suggestion-empty">暂无建议</div>';
  return `<div class="suggestions-list">${list.map((x, idx) => {
    const applied = x._applied;
    const actionBtn = x.action
      ? `<button class="btn btn-xs ${applied ? 'btn-ghost' : 'btn-primary'}" 
                 data-action="suggestion-apply" data-list="${listKey}" data-idx="${idx}" 
                 type="button" ${applied ? 'disabled' : ''}>
           ${applied ? '✓ 已采纳' : (x.action.kind === 'todo' ? '✓ 采纳为待办' : '✓ 采纳为目标')}
         </button>`
      : '';
    return `<div class="suggestion-item ${x.type || 'time'}${applied ? ' applied' : ''}">
      <span class="si-icon">${x.icon}</span>
      <span class="si-text">${esc(x.text)}</span>
      <div class="si-actions">
        <button class="btn btn-xs btn-ghost" data-action="suggestion-copy" data-list="${listKey}" data-idx="${idx}" type="button" title="复制">📋</button>
        ${actionBtn}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderMetricPreview(it) {
  if (it.value == null) return '';
  const unit = esc(it.unit || '');

  let convertTag = '';
  if (it.rawValue != null && it.rawUnit && it.unit && String(it.rawUnit).toLowerCase() !== String(it.unit).toLowerCase()) {
    const same = Math.abs(it.rawValue - it.value) < 1e-6;
    if (!same) {
      convertTag = `<span class="parse-preview-conv">${it.rawValue}${esc(it.rawUnit)}→${+it.value.toFixed(4)}${unit}</span>`;
    }
  }

  if (it.isNew) {
    let opText = '';
    if (it.op === 'add') opText = `+${+it.value.toFixed(4)}`;
    else if (it.op === 'sub') opText = `−${+it.value.toFixed(4)}`;
    else opText = `=${+it.value.toFixed(4)}`;
    return convertTag + `<span class="parse-preview set">新建指标：${opText}${unit}</span>`;
  }

  const m = findMetricByName(it.metricName, State.user?.id);
  const todayVal = m ? getTodayValue(m.id) : null;

  let main = '';
  if (it.op === 'add') {
    const base = todayVal != null ? todayVal : 0;
    const result = base + it.value;
    main = `<span class="parse-preview add">${base} + ${+it.value.toFixed(4)} = ${+result.toFixed(4)}${unit}</span>`;
  } else if (it.op === 'sub') {
    if (todayVal == null) {
      main = `<span class="parse-preview warn">⚠ 今日无基准值，无法减</span>`;
    } else {
      const result = todayVal - it.value;
      main = `<span class="parse-preview sub">${todayVal} − ${+it.value.toFixed(4)} = ${+result.toFixed(4)}${unit}</span>`;
    }
  } else {
    if (todayVal != null && todayVal !== it.value) {
      main = `<span class="parse-preview set">${todayVal} → ${+it.value.toFixed(4)}${unit}</span>`;
    } else {
      main = `<span class="parse-preview set">设置为 ${+it.value.toFixed(4)}${unit}</span>`;
    }
  }

  return convertTag + main;
}

function renderConfidenceBadge(conf) {
  const c = conf || 'mid';
  const map = {
    high: { label: '高', cls: 'conf-high', title: 'AI 很有把握' },
    mid:  { label: '中', cls: 'conf-mid',  title: 'AI 比较有把握，建议看一眼' },
    low:  { label: '低', cls: 'conf-low',  title: 'AI 把握不大，请核对后再确认' }
  };
  const x = map[c] || map.mid;
  return `<span class="parse-confidence ${x.cls}" title="${x.title}">${x.label}</span>`;
}

/* ⭐ 渲染星期几的中文 */
function dowCn(n) {
  if (n === null || n === undefined) return '';
  return '日一二三四五六'[n] || '';
}

function renderParseItem(it) {
  const c = it.confidence || 'mid';
  const chk = it.selected ? '<span style="color:var(--success);font-size:16px">☑</span>' : '<span style="color:var(--text-muted);font-size:16px">☐</span>';
  const editing = !!it.editing;

  /* ---- metric ---- */
  if (it.type === 'metric') {
    const badge = it.isNew
      ? `<span class="parse-new-badge" title="这个指标不在你的库里，点「+ 创建」添加">🆕 新指标</span>`
      : '';
    const createBtn = it.isNew
      ? `<button class="btn btn-xs btn-primary" data-action="metric-create-and-confirm" data-id="${it.id}" type="button" title="创建这个指标并录入数据">+ 创建</button>`
      : '';
    const op = it.op || 'set';
    const opBtn = (o, label) =>
      `<button class="parse-op-btn${op === o ? ' active' : ''}" 
              data-action="parse-set-op" data-id="${it.id}" data-op="${o}" 
              type="button" title="${o === 'set' ? '覆盖' : o === 'add' ? '累加' : '递减'}">${label}</button>`;

    let editRow = '';
    if (editing) {
      editRow = `
        <div class="parse-edit-row">
          <div class="parse-edit-field" style="flex:2">
            <label>📊 名称</label>
            <input type="text" class="parse-edit-input" data-parse-id="${it.id}" data-field="metricName" value="${esc(it.metricName)}">
          </div>
          <div class="parse-edit-field">
            <label>单位</label>
            <input type="text" class="parse-edit-input" data-parse-id="${it.id}" data-field="unit" value="${esc(it.unit || '')}" style="max-width:80px">
          </div>
          <div class="parse-edit-field">
            <label>📅 日期</label>
            <input type="date" class="parse-edit-input" data-parse-id="${it.id}" data-field="date" value="${it.date || today()}">
          </div>
        </div>`;
    }

    return `<div class="parse-result-item conf-${c}${it.isNew ? ' is-new' : ''}${editing ? ' editing' : ''}" data-parse-id="${it.id}">
      <div class="parse-main-row">
        <span style="cursor:pointer" data-action="parse-toggle" data-id="${it.id}">${chk}</span>
        <span class="parse-label">📊 ${esc(it.metricName)}</span>
        ${badge}
        <div class="parse-op-group">
          ${opBtn('set', '=')}
          ${opBtn('add', '+')}
          ${opBtn('sub', '−')}
        </div>
        <input type="number" class="parse-val" data-id="${it.id}" value="${it.value ?? ''}" step="0.01" placeholder="数值">
        <span style="font-size:11px;color:var(--text-muted)">${esc(it.unit)}</span>
        <span class="parse-preview-slot">${renderMetricPreview(it)}</span>
        ${createBtn}
        ${renderConfidenceBadge(c)}
        <button class="btn btn-xs btn-ghost" data-action="parse-edit-toggle" data-id="${it.id}" type="button" title="编辑">${editing ? '▲' : '✎'}</button>
        <button class="btn btn-xs btn-primary" data-action="parse-confirm" data-id="${it.id}" type="button" title="录入">✓</button>
        <button class="btn btn-xs btn-danger" data-action="parse-discard" data-id="${it.id}" type="button">✕</button>
      </div>
      ${editRow}
    </div>`;
  }

  /* ---- todo（带 repeat / weekday）---- */
  if (it.type === 'todo') {
    const availableGoals = DB.goals.filter(g => g.user_id === State.user.id && !g.completed);
    const goalOptions = availableGoals.map(g => {
      const tag = g.type === 'quant' ? `[量化 ${g.target_total || '?'}${g.unit || ''}]` : '[手动]';
      return `<option value="${g.id}"${it.goalId === g.id ? ' selected' : ''}>${esc(g.title)} ${tag}</option>`;
    }).join('');

    const repeatMap = {
      none: { icon: '', label: '' },
      daily: { icon: '🔁', label: '每天' },
      weekly: { icon: '🔁', label: '每周' },
      monthly: { icon: '🔁', label: '每月' }
    };
    const r = repeatMap[it.repeat] || repeatMap.none;
    const repeatTag = r.label ? `<span class="todo-repeat-tag">${r.icon} ${r.label}</span>` : '';

    /* ⭐ 星期几标签 */
    const weekdayTag = (it.weekday !== null && it.weekday !== undefined)
      ? `<span class="parse-date-tag">周${dowCn(it.weekday)}</span>`
      : '';

    let editRow = '';
    if (editing) {
      editRow = `
        <div class="parse-edit-row">
          <div class="parse-edit-field" style="flex:2">
            <label>📋 标题</label>
            <input type="text" class="parse-edit-input" data-parse-id="${it.id}" data-field="title" value="${esc(it.title)}">
          </div>
          <div class="parse-edit-field">
            <label>📅 日期</label>
            <input type="date" class="parse-edit-input" data-parse-id="${it.id}" data-field="date" value="${it.date || today()}">
          </div>
          <div class="parse-edit-field">
            <label>🔁 重复</label>
            <select class="parse-edit-input" data-parse-id="${it.id}" data-field="repeat">
              <option value="none"${it.repeat === 'none' ? ' selected' : ''}>不重复</option>
              <option value="daily"${it.repeat === 'daily' ? ' selected' : ''}>每天</option>
              <option value="weekly"${it.repeat === 'weekly' ? ' selected' : ''}>每周</option>
              <option value="monthly"${it.repeat === 'monthly' ? ' selected' : ''}>每月</option>
            </select>
          </div>
          <div class="parse-edit-field">
            <label>⚡ 优先级</label>
            <select class="parse-edit-input" data-parse-id="${it.id}" data-field="priority">
              <option value="high"${it.priority === 'high' ? ' selected' : ''}>🔴 高</option>
              <option value="medium"${!it.priority || it.priority === 'medium' ? ' selected' : ''}>🟡 中</option>
              <option value="low"${it.priority === 'low' ? ' selected' : ''}>🔵 低</option>
            </select>
          </div>
          ${availableGoals.length ? `
            <div class="parse-edit-field" style="flex:1.5">
              <label>🎯 关联目标</label>
              <select class="parse-edit-input" data-parse-id="${it.id}" data-field="goalId">
                <option value="">不关联</option>
                ${goalOptions}
              </select>
            </div>
          ` : ''}
        </div>`;
    }

    return `<div class="parse-result-item conf-${c}${editing ? ' editing' : ''}" data-parse-id="${it.id}">
      <div class="parse-main-row">
        <span style="cursor:pointer" data-action="parse-toggle" data-id="${it.id}">${chk}</span>
        <span class="parse-label">📋</span>
        <span style="flex:1;font-size:12px">${esc(it.title)}</span>
        ${repeatTag}
        ${weekdayTag}
        ${it.date !== today() ? `<span class="parse-date-tag">📅 ${esc(it.date)}</span>` : ''}
        ${it.goalId ? `<span class="parse-goal-tag">🎯</span>` : ''}
        ${renderConfidenceBadge(c)}
        <button class="btn btn-xs btn-ghost" data-action="parse-edit-toggle" data-id="${it.id}" type="button" title="编辑">${editing ? '▲' : '✎'}</button>
        <button class="btn btn-xs btn-primary" data-action="parse-confirm" data-id="${it.id}" type="button">✓</button>
        <button class="btn btn-xs btn-danger" data-action="parse-discard" data-id="${it.id}" type="button">✕</button>
      </div>
      ${editRow}
    </div>`;
  }

  /* ---- diet ---- */
  if (it.type === 'diet') {
    const mealMap = { breakfast: '🌅早餐', lunch: '🍚午餐', dinner: '🌆晚餐', snack: '🍪加餐' };

    let macroTag = '';
    if (it.calories > 0 || it.protein > 0 || it.carb > 0 || it.fat > 0) {
      const parts = [];
      if (it.calories > 0) parts.push(`🔥${it.calories}`);
      if (it.protein > 0 || it.carb > 0 || it.fat > 0) {
        parts.push(`P${(it.protein || 0).toFixed(0)}/C${(it.carb || 0).toFixed(0)}/F${(it.fat || 0).toFixed(0)}`);
      }
      macroTag = `<span class="parse-date-tag">${parts.join(' · ')}</span>`;
    }

    let editRow = '';
    if (editing) {
      editRow = `
        <div class="parse-edit-row">
          <div class="parse-edit-field" style="flex:2">
            <label>🍱 食物（逗号分隔）</label>
            <input type="text" class="parse-edit-input" data-parse-id="${it.id}" data-field="foodsText" value="${esc((it.foods || []).join('、'))}">
          </div>
          <div class="parse-edit-field">
            <label>🕐 餐次</label>
            <select class="parse-edit-input" data-parse-id="${it.id}" data-field="meal">
              <option value="breakfast"${it.meal === 'breakfast' ? ' selected' : ''}>早餐</option>
              <option value="lunch"${it.meal === 'lunch' ? ' selected' : ''}>午餐</option>
              <option value="dinner"${it.meal === 'dinner' ? ' selected' : ''}>晚餐</option>
              <option value="snack"${it.meal === 'snack' ? ' selected' : ''}>加餐</option>
            </select>
          </div>
        </div>
        <div class="parse-edit-row">
          <div class="parse-edit-field">
            <label>🔥 热量</label>
            <input type="number" class="parse-edit-input" data-parse-id="${it.id}" data-field="calories" value="${it.calories || 0}">
          </div>
          <div class="parse-edit-field">
            <label>🥩 蛋白</label>
            <input type="number" class="parse-edit-input" data-parse-id="${it.id}" data-field="protein" value="${it.protein || 0}" step="0.1">
          </div>
          <div class="parse-edit-field">
            <label>🌾 碳水</label>
            <input type="number" class="parse-edit-input" data-parse-id="${it.id}" data-field="carb" value="${it.carb || 0}" step="0.1">
          </div>
          <div class="parse-edit-field">
            <label>🥑 脂肪</label>
            <input type="number" class="parse-edit-input" data-parse-id="${it.id}" data-field="fat" value="${it.fat || 0}" step="0.1">
          </div>
        </div>`;
    }

    return `<div class="parse-result-item conf-${c}${editing ? ' editing' : ''}" data-parse-id="${it.id}">
      <div class="parse-main-row">
        <span style="cursor:pointer" data-action="parse-toggle" data-id="${it.id}">${chk}</span>
        <span class="parse-label">${mealMap[it.meal] || '🍱'}</span>
        <span style="flex:1;font-size:12px">${esc((it.foods || []).join('、'))}</span>
        ${macroTag}
        ${renderConfidenceBadge(c)}
        <button class="btn btn-xs btn-ghost" data-action="parse-edit-toggle" data-id="${it.id}" type="button" title="编辑">${editing ? '▲' : '✎'}</button>
        <button class="btn btn-xs btn-primary" data-action="parse-confirm" data-id="${it.id}" type="button">✓</button>
        <button class="btn btn-xs btn-danger" data-action="parse-discard" data-id="${it.id}" type="button">✕</button>
      </div>
      ${editRow}
    </div>`;
  }

  /* ---- exercise ---- */
  if (it.type === 'exercise') {
    const intensityMap = { low: '轻', medium: '中', high: '重' };
    let editRow = '';
    if (editing) {
      editRow = `
        <div class="parse-edit-row">
          <div class="parse-edit-field" style="flex:2">
            <label>🏃 项目</label>
            <input type="text" class="parse-edit-input" data-parse-id="${it.id}" data-field="sport" value="${esc(it.sport)}">
          </div>
          <div class="parse-edit-field">
            <label>⏱️ 分钟</label>
            <input type="number" class="parse-edit-input" data-parse-id="${it.id}" data-field="value" value="${it.value || 0}">
          </div>
          <div class="parse-edit-field">
            <label>⚡ 强度</label>
            <select class="parse-edit-input" data-parse-id="${it.id}" data-field="intensity">
              <option value="low"${it.intensity === 'low' ? ' selected' : ''}>轻</option>
              <option value="medium"${it.intensity === 'medium' ? ' selected' : ''}>中</option>
              <option value="high"${it.intensity === 'high' ? ' selected' : ''}>重</option>
            </select>
          </div>
        </div>`;
    }

    return `<div class="parse-result-item conf-${c}${editing ? ' editing' : ''}" data-parse-id="${it.id}">
      <div class="parse-main-row">
        <span style="cursor:pointer" data-action="parse-toggle" data-id="${it.id}">${chk}</span>
        <span class="parse-label">🏃</span>
        <span style="flex:1;font-size:12px">${esc(it.sport)} · ${it.value} 分钟 · 强度${intensityMap[it.intensity] || '中'}</span>
        ${renderConfidenceBadge(c)}
        <button class="btn btn-xs btn-ghost" data-action="parse-edit-toggle" data-id="${it.id}" type="button" title="编辑">${editing ? '▲' : '✎'}</button>
        <button class="btn btn-xs btn-primary" data-action="parse-confirm" data-id="${it.id}" type="button">✓</button>
        <button class="btn btn-xs btn-danger" data-action="parse-discard" data-id="${it.id}" type="button">✕</button>
      </div>
      ${editRow}
    </div>`;
  }

  return '';
}

function localSuggestions() {
  const s = [];
  const w = State.weather;
  if (w) {
    if (w.temp <= 5) s.push({ icon: '🧥', text: `气温 ${w.temp}°，穿厚外套`, type: 'weather' });
    else if (w.temp >= 30) s.push({ icon: '☀️', text: `高温 ${w.temp}°，注意防暑`, type: 'weather' });
  }
  const undone = DB.todos.filter(t => t.user_id === State.user.id && t.date === today() && !t.completed);
  if (undone.length) s.push({ icon: '📋', text: `还有 ${undone.length} 项待办`, type: 'todo' });
  else s.push({ icon: '😌', text: '今日待办已清空', type: 'todo' });
  const hour = new Date().getHours();
  if (hour < 12) s.push({ icon: '☕', text: '上午适合处理重要任务', type: 'time' });
  else s.push({ icon: '🌆', text: '晚上回顾今天的收获', type: 'time' });
  return s;
}

/* ============ 全局 input / change ============ */
document.addEventListener('input', e => {
  const t = e.target;

  if (t.classList && t.classList.contains('parse-val')) {
    const it = State.parsedItems.find(x => x.id === t.dataset.id);
    if (!it) return;
    const v = t.value.trim();
    if (v === '') {
      it.value = null;
      it.needsValue = true;
    } else {
      it.value = parseFloat(v);
      if (isNaN(it.value)) it.value = 0;
      it.needsValue = false;
      it.selected = true;
    }
    const itemEl = document.querySelector(`[data-parse-id="${it.id}"]`);
    if (itemEl) {
      const slot = itemEl.querySelector('.parse-preview-slot');
      if (slot) slot.innerHTML = renderMetricPreview(it);
    }
    persistAIState();
    return;
  }

  if (t.classList && t.classList.contains('parse-edit-input')) {
    const it = State.parsedItems.find(x => x.id === t.dataset.parseId);
    if (!it) return;
    const field = t.dataset.field;
    if (field === 'foodsText') {
      it.foods = t.value.split(/[,，、;；]/).map(s => s.trim()).filter(Boolean);
    } else if (field === 'value' || field === 'calories' || field === 'protein' || field === 'carb' || field === 'fat') {
      it[field] = parseFloat(t.value) || 0;
    } else {
      it[field] = t.value;
    }

    if (field === 'metricName' && it.type === 'metric') {
      const m = findMetricByName(t.value, State.user?.id);
      if (m) {
        it.matched = true;
        it.isNew = false;
        if (m.unit) it.unit = m.unit;
      } else {
        it.matched = false;
        it.isNew = true;
      }
    }
    persistAIState();
    return;
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.classList && t.classList.contains('parse-edit-input')) {
    const it = State.parsedItems.find(x => x.id === t.dataset.parseId);
    if (!it) return;
    const field = t.dataset.field;
    if (field === 'foodsText') {
      it.foods = t.value.split(/[,，、;；]/).map(s => s.trim()).filter(Boolean);
    } else if (field === 'value' || field === 'calories' || field === 'protein' || field === 'carb' || field === 'fat') {
      it[field] = parseFloat(t.value) || 0;
    } else {
      it[field] = t.value;
    }

    if (field === 'metricName' && it.type === 'metric') {
      const m = findMetricByName(t.value, State.user?.id);
      if (m) {
        it.matched = true;
        it.isNew = false;
        if (m.unit) it.unit = m.unit;
      } else {
        it.matched = false;
        it.isNew = true;
      }
    }
    persistAIState();
  }
});

/* ============ Actions ============ */
export const actions = {
  'ai-refresh': () => AIHub.run(),

  'ai-refresh-suggestions': async () => {
    if (!AIHub.isEnabled()) {
      State.aiSuggestions = null;
      persistAIState();
      rerender();
      toast('已刷新本地建议', 'success');
      return;
    }
    try {
      const suggestions = await AIHub.generateSuggestions();
      State.aiSuggestions = suggestions.length ? suggestions : null;
      persistAIState();
      toast('建议已刷新', 'success');
    } catch (e) {
      console.warn('[AI] 刷新建议失败:', e);
      toast('刷新失败：' + (e.message || e), 'error');
    }
    rerender();
  },

  'toggle-suggestions-expand': () => {
    State.suggestionsExpanded = !State.suggestionsExpanded;
    rerender();
  },

  'suggestion-apply': (el) => {
    const idx = parseInt(el.dataset.idx);
    const list = State.aiSuggestions || [];
    const s = list[idx];
    if (!s || !s.action) { toast('该建议没有可执行动作', 'info'); return; }

    const a = s.action;
    if (a.kind === 'todo') {
      if (!a.title) { toast('缺少标题', 'warning'); return; }
      const tid = uid();
      DB.todos.push({
        id: tid,
        user_id: State.user.id,
        title: a.title,
        date: today(),
        time: '09:00',
        priority: 'medium',
        repeat: 'none',
        subtasks: [],
        goalId: null,
        goalContribution: 0,
        completed: false,
        createdAt: new Date().toISOString()
      });
      save('todos');
      emit('db:changed');
      s._applied = true;
      persistAIState();
      toast(`✅ 已添加待办：${a.title}`, 'success', {
        actions: [{ label: '撤销', onClick: () => {
          DB.todos = DB.todos.filter(x => x.id !== tid);
          save('todos');
          emit('db:changed');
          s._applied = false;
          persistAIState();
          rerender();
          toast('已撤销', 'success');
        }}]
      });
      rerender();
    } else if (a.kind === 'goal') {
      if (!a.title) { toast('缺少目标名称', 'warning'); return; }
      const gid = uid();
      const g = {
        id: gid,
        user_id: State.user.id,
        title: a.title,
        type: a.type || 'manual',
        progress: 0,
        records: [],
        target_total: a.target_total || 0,
        unit: a.unit || '',
        deadline: null,
        pinned: false,
        createdAt: new Date().toISOString(),
        completed: false,
        completedAt: null
      };
      DB.goals.push(g);
      save('goals');
      emit('db:changed');
      s._applied = true;
      persistAIState();
      toast(`✅ 已添加目标：${a.title}`, 'success', {
        actions: [{ label: '撤销', onClick: () => {
          DB.goals = DB.goals.filter(x => x.id !== gid);
          save('goals');
          emit('db:changed');
          s._applied = false;
          persistAIState();
          rerender();
          toast('已撤销', 'success');
        }}]
      });
      rerender();
    }
  },

  'suggestion-copy': (el) => {
    const idx = parseInt(el.dataset.idx);
    const list = State.aiSuggestions || [];
    const s = list[idx];
    if (!s) return;
    navigator.clipboard.writeText(s.text).then(
      () => toast('已复制', 'success'),
      () => toast('复制失败', 'error')
    );
  },

  'parse-edit-toggle': (el) => {
    const it = State.parsedItems.find(x => x.id === el.dataset.id);
    if (!it) return;
    it.editing = !it.editing;
    persistAIState();
    rerender();
  },

  'parse-toggle': (el) => {
    const it = State.parsedItems.find(x => x.id === el.dataset.id);
    if (!it) return;
    it.selected = !it.selected;
    persistAIState();
    const itemEl = document.querySelector(`[data-parse-id="${it.id}"]`);
    if (itemEl) {
      const chk = itemEl.querySelector('[data-action="parse-toggle"]');
      if (chk) chk.innerHTML = it.selected
        ? '<span style="color:var(--success);font-size:16px">☑</span>'
        : '<span style="color:var(--text-muted);font-size:16px">☐</span>';
    }
  },

  'parse-set-op': (el) => {
    const it = State.parsedItems.find(x => x.id === el.dataset.id);
    if (!it) return;
    it.op = el.dataset.op;
    if (!it.isNew && it.value != null) {
      const m = findMetricByName(it.metricName, State.user?.id);
      if (m) {
        if (it.op === 'set') {
          it.confidence = isValueReasonable(it.metricName, it.value) ? (it.confidence === 'low' ? 'mid' : it.confidence) : 'low';
        } else {
          it.confidence = isDeltaReasonable(it.metricName, it.value) ? (it.confidence === 'low' ? 'mid' : it.confidence) : 'low';
        }
      }
    }
    persistAIState();
    const itemEl = document.querySelector(`[data-parse-id="${it.id}"]`);
    if (itemEl) {
      itemEl.querySelectorAll('.parse-op-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.op === it.op);
      });
      const slot = itemEl.querySelector('.parse-preview-slot');
      if (slot) slot.innerHTML = renderMetricPreview(it);
      const confEl = itemEl.querySelector('.parse-confidence');
      if (confEl) confEl.outerHTML = renderConfidenceBadge(it.confidence);
    }
  },

  'metric-create-and-confirm': (el) => {
    const it = State.parsedItems.find(x => x.id === el.dataset.id);
    if (!it) { toast('解析项已失效，请重新生成', 'warning'); return; }
    if (!it.isNew) { toast('这不是新指标，直接点 ✓ 录入即可', 'info'); return; }

    const suggestedUnit = it.suggestedUnit || it.unit || '';
    const suggestedDir = guessTargetDir(it.metricName);

    showModal('metricCreateFromParse', `
      <h3 style="font-size:16px;margin-bottom:12px;font-weight:800">🆕 创建新指标</h3>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px">AI 从随笔里识别到一个新指标，确认一下基础信息：</div>
      <div style="margin-bottom:12px">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">指标名称</label>
        <input type="text" class="input" id="newMetricName" value="${esc(it.metricName)}">
      </div>
      <div style="display:flex;gap:10px;margin-bottom:12px">
        <div style="flex:1">
          <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">单位</label>
          <input type="text" class="input" id="newMetricUnit" value="${esc(suggestedUnit)}" placeholder="如 kg / 个 / 分钟">
        </div>
        <div style="flex:1">
          <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">目标值（可选）</label>
          <input type="number" class="input" id="newMetricTarget" step="0.1" placeholder="留空=无目标">
        </div>
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px">目标方向</label>
        <select class="input" id="newMetricDir">
          <option value="higher"${suggestedDir === 'higher' ? ' selected' : ''}>↑ 越高越好</option>
          <option value="lower"${suggestedDir === 'lower' ? ' selected' : ''}>↓ 越低越好</option>
        </select>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
        <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
        <button class="btn btn-sm btn-primary" data-action="metric-create-save" data-parse-id="${it.id}" type="button">✓ 创建并录入</button>
      </div>
    `, 'md');
  },

  'metric-create-save': (el) => {
    const parseId = el.dataset.parseId;
    const it = State.parsedItems.find(x => x.id === parseId);
    if (!it) { toast('条目已失效', 'warning'); hideModal(); return; }
    const nameEl = document.getElementById('newMetricName');
    const unitEl = document.getElementById('newMetricUnit');
    const targetEl = document.getElementById('newMetricTarget');
    const dirEl = document.getElementById('newMetricDir');
    if (!nameEl) { toast('表单丢失', 'error'); hideModal(); return; }
    const name = nameEl.value.trim();
    const unit = unitEl ? unitEl.value.trim() : '';
    const targetRaw = targetEl ? targetEl.value.trim() : '';
    const target = targetRaw === '' ? 0 : (parseFloat(targetRaw) || 0);
    const dir = dirEl ? (dirEl.value || 'higher') : 'higher';
    if (!name) { toast('请输入指标名称', 'warning'); return; }
    if (DB.metrics.some(m => m.user_id === State.user.id && m.name === name)) {
      toast('已存在同名指标', 'warning');
      return;
    }
    const newMetric = {
      id: uid(), user_id: State.user.id, name, unit,
      target_value: target, target_dir: dir,
      pinned: false, isDerived: false,
      createdAt: new Date().toISOString()
    };
    DB.metrics.push(newMetric);
    save('metrics');
    emit('db:changed');
    it.metricName = name;
    it.unit = unit;
    it.matched = true;
    it.isNew = false;
    const ok = applyParseItem(it);
    if (ok) {
      State.parsedItems = State.parsedItems.filter(x => x.id !== it.id);
      State.metricCache = {};
      persistAIStateNow();
      hideModal();
      toast(`已创建指标「${name}」并录入数据`, 'success');
      rerender();
    } else {
      toast('指标已创建，但数据录入失败', 'error');
      hideModal();
      rerender();
    }
  },

  'parse-confirm': (el) => {
    const it = State.parsedItems.find(x => x.id === el.dataset.id);
    if (!it) return;
    if (it.type === 'metric' && it.isNew) { toast('这是新指标，请先点「+ 创建」', 'warning'); return; }
    if (!applyParseItem(it)) return;
    State.parsedItems = State.parsedItems.filter(x => x.id !== it.id);
    toast('已录入', 'success');
    State.metricCache = {};
    persistAIStateNow();
    rerender();
  },

  'parse-confirm-all': () => {
    const sel = State.parsedItems.filter(x => x.selected);
    const valid = sel.filter(it =>
      !(it.type === 'metric' && (it.value === null || it.needsValue)) &&
      !(it.type === 'metric' && it.isNew)
    );
    const skippedNew = sel.filter(it => it.type === 'metric' && it.isNew).length;

    if (!valid.length) {
      if (skippedNew) toast(`有 ${skippedNew} 项新指标需要先创建`, 'warning');
      else toast('没有可录入的项', 'warning');
      return;
    }
    let ok = 0;
    const failed = [];
    valid.forEach(it => {
      const r = applyParseItem(it);
      if (r) ok++;
      else failed.push(it);
    });
    State.parsedItems = State.parsedItems.filter(x => !valid.includes(x) || failed.includes(x));
    const tip = skippedNew ? `已录入 ${ok} 项，跳过 ${skippedNew} 个新指标` : `已录入 ${ok} 项`;
    toast(tip, ok ? 'success' : 'warning');
    emit('db:changed');
    State.metricCache = {};
    persistAIStateNow();
    rerender();
  },

  'parse-discard': (el) => {
    State.parsedItems = State.parsedItems.filter(x => x.id !== el.dataset.id);
    persistAIState();
    rerender();
  }
};

/* ============ 应用一条解析项 ============ */
function applyParseItem(it) {
  /* ---- metric ---- */
  if (it.type === 'metric') {
    const val = parseFloat(it.value);
    if (isNaN(val)) return false;
    const userId = State.user.id;
    const m = findMetricByName(it.metricName, userId);
    if (!m) { toast(`未找到指标「${it.metricName}」`, 'warning'); return false; }
    const date = it.date || today();

    const ex = DB.metricValues.find(v => v.metric_id === m.id && v.date === date && !v.sourceType);
    const todayVal = ex ? ex.value : null;

    let finalValue;
    if (it.op === 'add') {
      finalValue = (todayVal || 0) + val;
    } else if (it.op === 'sub') {
      if (todayVal == null) { toast(`「${m.name}」${date} 还没有基准值，无法减`, 'warning'); return false; }
      finalValue = todayVal - val;
      if (finalValue < 0) {
        toast(`「${m.name}」减去 ${val} 会变成负数`, 'warning');
        return false;
      }
    } else {
      finalValue = val;
    }

    if (it.op === 'set' && !isValueReasonable(m.name, finalValue)) {
      if (!confirm(`「${m.name}」= ${finalValue}，超出常见范围，确定录入？`)) return false;
    }

    if (ex) ex.value = finalValue;
    else DB.metricValues.push({
      id: uid(), metric_id: m.id, date,
      value: finalValue, createdAt: new Date().toISOString()
    });
    save('metricValues');
    emit('db:changed');
    State.metricCache = {};
    return true;
  }

  /* ---- todo ---- */
  if (it.type === 'todo') {
    const title = String(it.title || '').trim();
    if (!title) { toast('待办标题为空', 'warning'); return false; }
    DB.todos.push({
      id: uid(),
      user_id: State.user.id,
      title,
      date: it.date || today(),
      time: '09:00',
      priority: ['high', 'medium', 'low'].includes(it.priority) ? it.priority : 'medium',
      repeat: ['none', 'daily', 'weekly', 'monthly'].includes(it.repeat) ? it.repeat : 'none',
      subtasks: [],
      goalId: it.goalId || null,
      goalContribution: parseFloat(it.goalContribution) || 0,
      completed: false,
      createdAt: new Date().toISOString()
    });
    save('todos');
    emit('db:changed');
    return true;
  }

  /* ---- diet ---- */
  if (it.type === 'diet') {
    const foods = Array.isArray(it.foods) ? it.foods : [];
    if (!foods.length) { toast('食物为空', 'warning'); return false; }
    const date = it.date || today();
    const u = State.user.id;

    DB.healthRecords.push({
      id: uid(),
      user_id: u,
      date,
      type: 'diet',
      meal: it.meal || 'lunch',
      foods,
      calories: it.calories || 0,
      protein: it.protein || 0,
      carb: it.carb || 0,
      fat: it.fat || 0,
      note: it.note || '',
      value: it.calories || 0,
      unit: it.calories ? 'kcal' : '',
      savedAt: new Date().toISOString()
    });
    save('healthRecords');
    emit('db:changed');

    syncMetricForDiet(date);

    return true;
  }

  /* ---- exercise ---- */
  if (it.type === 'exercise') {
    const minutes = parseInt(it.value) || 0;
    if (minutes <= 0) { toast('运动时长无效', 'warning'); return false; }
    const date = it.date || today();
    const u = State.user.id;

    DB.healthRecords.push({
      id: uid(),
      user_id: u,
      date,
      type: 'exercise',
      value: minutes,
      unit: '分钟',
      sport: it.sport || '其他',
      intensity: it.intensity || 'medium',
      note: it.note || '',
      savedAt: new Date().toISOString()
    });
    save('healthRecords');
    emit('db:changed');

    syncMetricForExercise(date);

    return true;
  }

  return false;
}

/* ============================================================
 * 内部：指标同步
 * ============================================================ */

function ensureMetricSimple(userId, name, unit, dir) {
  let m = DB.metrics.find(x => x.user_id === userId && x.name === name);
  if (m) return m;
  m = {
    id: uid(), user_id: userId, name, unit,
    target_value: 0, target_dir: dir || 'higher',
    pinned: false, isDerived: false,
    createdAt: new Date().toISOString()
  };
  DB.metrics.push(m);
  save('metrics');
  return m;
}

function upsertMetricValueSimple(metricId, date, value) {
  DB.metricValues = DB.metricValues.filter(v =>
    !(v.metric_id === metricId && v.date === date && v.sourceType === 'health'));
  DB.metricValues.push({
    id: uid(), metric_id: metricId, date, value,
    sourceType: 'health',
    createdAt: new Date().toISOString()
  });
}

function syncMetricForDiet(date) {
  const u = State.user.id;
  const recs = DB.healthRecords.filter(r => r.user_id === u && r.date === date && r.type === 'diet');

  const calories = recs.reduce((s, r) => s + (r.calories || r.value || 0), 0);
  setMetricIf('卡路里', 'kcal', 'lower', calories, date);

  const protein = +recs.reduce((s, r) => s + (parseFloat(r.protein) || 0), 0).toFixed(1);
  setMetricIf('蛋白质', '克', 'higher', protein, date);

  const carb = +recs.reduce((s, r) => s + (parseFloat(r.carb) || 0), 0).toFixed(1);
  setMetricIf('碳水', '克', 'higher', carb, date);

  const fat = +recs.reduce((s, r) => s + (parseFloat(r.fat) || 0), 0).toFixed(1);
  setMetricIf('脂肪', '克', 'lower', fat, date);

  save('metrics', 'metricValues');
  emit('db:changed');
}

function syncMetricForExercise(date) {
  const u = State.user.id;
  const recs = DB.healthRecords.filter(r => r.user_id === u && r.date === date && r.type === 'exercise');
  const total = recs.reduce((s, r) => s + (r.value || 0), 0);
  setMetricIf('运动时长', '分钟', 'higher', total, date);
  save('metrics', 'metricValues');
  emit('db:changed');
}

function setMetricIf(name, unit, dir, value, date) {
  const u = State.user.id;
  const m = ensureMetricSimple(u, name, unit, dir);
  if (value > 0) {
    upsertMetricValueSimple(m.id, date, value);
  } else {
    DB.metricValues = DB.metricValues.filter(v =>
      !(v.metric_id === m.id && v.date === date && v.sourceType === 'health'));
  }
}