import { DB, State, save, snapshotDelete, undo, getDataVersion } from '../../core/db.js';
import { esc, today, uid, fmtD, addDays, weekStart } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';

if (!Array.isArray(DB.healthRecords)) DB.healthRecords = [];
if (!Array.isArray(DB.healthGoals)) DB.healthGoals = [];

const WATER_PRESETS = [100, 200, 250, 300, 500];
const DIET_FOOD_PRESETS = ['米饭', '面条', '鸡蛋', '鸡胸肉', '青菜', '水果', '牛奶', '咖啡'];
const GOAL_TYPES = [
  { key: 'water',    icon: '💧', name: '饮水',   unit: 'ml' },
  { key: 'sleep',    icon: '😴', name: '睡眠',   unit: '小时' },
  { key: 'exercise', icon: '🏃', name: '运动',   unit: '分钟' },
  { key: 'calories', icon: '🍱', name: '卡路里', unit: 'kcal' }
];

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

const BASE_PAL = 1.2;
const TEF_RATIO = 0.10;

let viewDate = today();

/* ============ 查询工具 ============ */
function recordsOn(date) {
  const u = State.user?.id;
  if (!u) return [];
  return DB.healthRecords
    .filter(r => r.user_id === u && r.date === date)
    .sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
}

function sumByOn(type, date) {
  const u = State.user?.id;
  if (!u) return 0;
  return DB.healthRecords
    .filter(r => r.user_id === u && r.date === date && r.type === type)
    .reduce((s, r) => s + (r.value || 0), 0);
}

function sumBy(type) { return sumByOn(type, viewDate); }

/** ⭐ 汇总某天营养素 */
function sumNutritionOn(date) {
  const u = State.user?.id;
  if (!u) return { protein: 0, carb: 0, fat: 0, calories: 0 };
  const recs = DB.healthRecords.filter(r => r.user_id === u && r.date === date && r.type === 'diet');
  return recs.reduce((acc, r) => ({
    protein: acc.protein + (parseFloat(r.protein) || 0),
    carb: acc.carb + (parseFloat(r.carb) || 0),
    fat: acc.fat + (parseFloat(r.fat) || 0),
    calories: acc.calories + (r.calories || 0)
  }), { protein: 0, carb: 0, fat: 0, calories: 0 });
}

/* ================================================================
 * 能量计算
 * ================================================================ */
function calcBMR() {
  const u = State.user;
  if (!u) return 1400;
  const w = u.weight || 60;
  const h = u.height || 170;
  const a = u.age || 25;
  const g = u.gender || 'male';
  if (g === 'female') return Math.round(9.99 * w + 6.25 * h - 4.92 * a - 161);
  return Math.round(9.99 * w + 6.25 * h - 4.92 * a + 5);
}

function getExerciseKcal(record) {
  if (!record || record.type !== 'exercise') return 0;
  const w = (State.user && State.user.weight) || 60;
  const mins = record.value || 0;
  const sportMets = METS[record.sport] || METS['其他'];
  const mets = sportMets[record.intensity] || sportMets.medium;
  return Math.round((mets - 1) * w * (mins / 60));
}

function calcTodayEnergy() {
  const recs = recordsOn(viewDate);
  const intake = recs.filter(r => r.type === 'diet').reduce((s, r) => s + (r.calories || r.value || 0), 0);
  const exerciseKcal = recs.filter(r => r.type === 'exercise').reduce((s, r) => s + getExerciseKcal(r), 0);
  const bmr = calcBMR();
  const baseBurn = Math.round(bmr * BASE_PAL);
  const tef = Math.round(intake * TEF_RATIO);
  const burned = baseBurn + exerciseKcal + tef;
  const net = intake - burned;
  return { intake, exerciseKcal, bmr, baseBurn, tef, burned, net };
}

/* ================================================================
 * 健康目标
 * ================================================================ */
function getGoal(type) {
  const u = State.user?.id;
  if (!u) return null;
  return DB.healthGoals.find(g => g.user_id === u && g.type === type) || null;
}

function setGoal(type, targetValue, unit, linkedType, linkedId) {
  const u = State.user.id;
  let g = DB.healthGoals.find(x => x.user_id === u && x.type === type);
  if (!g) {
    g = {
      id: uid(), user_id: u, type, target_value: targetValue, unit,
      linkedType: linkedType || null,
      linkedId: linkedId || null,
      createdAt: new Date().toISOString()
    };
    DB.healthGoals.push(g);
  } else {
    g.target_value = targetValue;
    g.unit = unit;
    g.linkedType = linkedType || null;
    g.linkedId = linkedId || null;
  }
  save('healthGoals');
  emit('db:changed');
  syncHealthGoalLink(type, today());
}

function removeGoal(type) {
  const u = State.user.id;
  const before = DB.healthGoals.length;
  DB.healthGoals = DB.healthGoals.filter(x => !(x.user_id === u && x.type === type));
  if (DB.healthGoals.length !== before) {
    save('healthGoals');
    emit('db:changed');
  }
}

/* ================================================================
 * 健康目标 → 习惯 / 目标 绑定同步
 * ================================================================ */
function isHealthGoalReached(type, date) {
  const g = getGoal(type);
  if (!g || !(g.target_value > 0)) return false;

  let cur = 0;
  if (type === 'water')    cur = sumByOn('water', date);
  else if (type === 'sleep')    cur = +sumByOn('sleep', date).toFixed(1);
  else if (type === 'exercise') cur = sumByOn('exercise', date);
  else if (type === 'calories') {
    cur = recordsOn(date).filter(r => r.type === 'diet').reduce((s, r) => s + (r.calories || r.value || 0), 0);
  }

  if (type === 'calories') return cur > 0 && cur <= g.target_value;
  return cur >= g.target_value;
}

function getHealthGoalCurrent(type, date) {
  if (type === 'water')    return sumByOn('water', date);
  if (type === 'sleep')    return +sumByOn('sleep', date).toFixed(1);
  if (type === 'exercise') return sumByOn('exercise', date);
  if (type === 'calories') {
    return recordsOn(date).filter(r => r.type === 'diet').reduce((s, r) => s + (r.calories || r.value || 0), 0);
  }
  return 0;
}

function syncHealthGoalLink(type, date) {
  const u = State.user?.id;
  if (!u) return;
  const d = date || viewDate;
  if (d !== today()) return;

  const g = DB.healthGoals.find(x => x.user_id === u && x.type === type);
  if (!g || !g.linkedType || !g.linkedId) return;

  if (g.linkedType === 'habit') syncToHabit(g, d);
  else if (g.linkedType === 'goal') syncToGoal(g, d);
}

function syncToHabit(healthGoal, date) {
  const u = State.user.id;
  const habit = DB.habits.find(h => h.id === healthGoal.linkedId && h.user_id === u);
  if (!habit) return;

  const reached = isHealthGoalReached(healthGoal.type, date);
  const exLog = DB.habitLogs.find(l => l.user_id === u && l.habit_id === habit.id && l.date === date);

  if (reached && !exLog) {
    DB.habitLogs.push({
      id: uid(), user_id: u, habit_id: habit.id, date,
      createdAt: new Date().toISOString(),
      source: 'health', sourceType: healthGoal.type
    });
    save('habitLogs');
    emit('db:changed');
  } else if (!reached && exLog && exLog.source === 'health') {
    DB.habitLogs = DB.habitLogs.filter(l => l.id !== exLog.id);
    save('habitLogs');
    emit('db:changed');
  }
}

function syncToGoal(healthGoal, date) {
  const u = State.user.id;
  const goal = DB.goals.find(g => g.id === healthGoal.linkedId && g.user_id === u);
  if (!goal || goal.type !== 'quant') return;

  const current = getHealthGoalCurrent(healthGoal.type, date);
  const RECORD_SOURCE = 'health:' + healthGoal.type;
  if (!Array.isArray(goal.records)) goal.records = [];

  const exRec = goal.records.find(r => r.date === date && r.source === RECORD_SOURCE);

  if (current > 0) {
    if (exRec) {
      exRec.value = current;
      exRec.createdAt = new Date().toISOString();
    } else {
      goal.records.push({
        id: uid(),
        value: current,
        note: `来自健康：${labelOfType(healthGoal.type)}`,
        date, source: RECORD_SOURCE,
        createdAt: new Date().toISOString()
      });
    }
    syncGoalDone(goal);
    save('goals');
    emit('db:changed');
  } else if (exRec) {
    goal.records = goal.records.filter(r => r.id !== exRec.id);
    syncGoalDone(goal);
    save('goals');
    emit('db:changed');
  }
}

function labelOfType(type) {
  return { water: '饮水', sleep: '睡眠', exercise: '运动', calories: '卡路里' }[type] || type;
}

function syncGoalDone(g) {
  if (!g) return;
  const isDoneNow = (() => {
    if (g.type === 'quant') {
      const total = (g.records || []).reduce((s, r) => s + (parseFloat(r.value) || 0), 0);
      const target = parseFloat(g.target_total) || 0;
      return target > 0 && total / target >= 1;
    }
    return (parseInt(g.progress) || 0) >= 100;
  })();
  if (isDoneNow && !g.completed) { g.completed = true; g.completedAt = new Date().toISOString(); }
  else if (!isDoneNow && g.completed) { g.completed = false; g.completedAt = null; }
}

/* ============ 指标联动 ============ */
function ensureMetric(userId, name, unit, dir) {
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

function upsertMetricValue(metricId, date, value) {
  DB.metricValues = DB.metricValues.filter(v =>
    !(v.metric_id === metricId && v.date === date && v.sourceType === 'health'));
  DB.metricValues.push({
    id: uid(), metric_id: metricId, date, value,
    sourceType: 'health',
    createdAt: new Date().toISOString()
  });
}

function convertWaterToUnit(ml, targetUnit) {
  const t = String(targetUnit || '').trim().toLowerCase();
  if (t === '升' || t === 'l') return +(ml / 1000).toFixed(3);
  if (t === 'ml' || t === '毫升') return ml;
  return ml;
}

function metaForType(type) {
  if (type === 'sleep')    return { name: '睡眠时长', unit: '小时', dir: 'higher' };
  if (type === 'exercise') return { name: '运动时长', unit: '分钟', dir: 'higher' };
  if (type === 'water')    return { name: '饮水量',   unit: '升',   dir: 'higher' };
  if (type === 'diet')     return { name: '卡路里',   unit: 'kcal', dir: 'lower' };
  if (type === 'protein')  return { name: '蛋白质',   unit: '克',   dir: 'higher' };
  if (type === 'carb')     return { name: '碳水',     unit: '克',   dir: 'higher' };
  if (type === 'fat')      return { name: '脂肪',     unit: '克',   dir: 'lower' };
  return null;
}

/** ⭐ 按 type 汇总写入指标 */
function syncMetricForDate(type, date) {
  const u = State.user?.id;
  if (!u) return;
  const d = date || viewDate;

  /* 营养素类型从 diet 记录里抽字段汇总，其余走 value */
  let name, unit, dir, total;
  if (type === 'protein' || type === 'carb' || type === 'fat') {
    const meta = metaForType(type);
    name = meta.name; unit = meta.unit; dir = meta.dir;
    const recs = DB.healthRecords.filter(r => r.user_id === u && r.date === d && r.type === 'diet');
    total = recs.reduce((s, r) => s + (parseFloat(r[type]) || 0), 0);
    total = +total.toFixed(1);
  } else {
    const meta = metaForType(type);
    if (!meta) return;
    name = meta.name; unit = meta.unit; dir = meta.dir;
    const recs = DB.healthRecords.filter(r => r.user_id === u && r.date === d && r.type === type);

    if (!recs.length) {
      const m = DB.metrics.find(x => x.user_id === u && x.name === name);
      if (m) {
        const before = DB.metricValues.length;
        DB.metricValues = DB.metricValues.filter(v =>
          !(v.metric_id === m.id && v.date === d && v.sourceType === 'health'));
        if (DB.metricValues.length !== before) {
          save('metricValues');
          emit('db:changed');
        }
      }
      if (d === today()) syncHealthGoalLink(type, d);
      return;
    }

    if (type === 'sleep') total = +recs.reduce((s, r) => s + (r.value || 0), 0).toFixed(1);
    else if (type === 'diet') total = recs.reduce((s, r) => s + (r.calories || r.value || 0), 0);
    else total = recs.reduce((s, r) => s + (r.value || 0), 0);
  }

  if (total > 0) {
    const m = ensureMetric(u, name, unit, dir);
    let finalValue = total;
    if (type === 'water') finalValue = convertWaterToUnit(total, m.unit);
    upsertMetricValue(m.id, d, finalValue);
    save('metrics', 'metricValues');
    emit('db:changed');
  } else {
    const m = DB.metrics.find(x => x.user_id === u && x.name === name);
    if (m) {
      const before = DB.metricValues.length;
      DB.metricValues = DB.metricValues.filter(v =>
        !(v.metric_id === m.id && v.date === d && v.sourceType === 'health'));
      if (DB.metricValues.length !== before) {
        save('metricValues');
        emit('db:changed');
      }
    }
  }

  if (d === today()) syncHealthGoalLink(type, d);
}

/** 一条 diet 记录修改后，四个指标（卡路里/蛋白/碳水/脂肪）都要同步 */
function syncDietAll(date) {
  syncMetricForDate('diet', date);
  syncMetricForDate('protein', date);
  syncMetricForDate('carb', date);
  syncMetricForDate('fat', date);
}

/* ============ 概览 ============ */
function getOverview(date) {
  const sleepSum = sumByOn('sleep', date);
  return {
    sleepSum: +sleepSum.toFixed(1),
    exercise: sumByOn('exercise', date),
    water: sumByOn('water', date),
    diet: recordsOn(date).filter(r => r.type === 'diet').length,
    calories: recordsOn(date)
      .filter(r => r.type === 'diet')
      .reduce((s, r) => s + (r.calories || r.value || 0), 0)
  };
}

/* ============ 图表 ============ */
function setupCanvas(canvas, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10) return null;
  const w = rect.width;
  const h = cssHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function roundRectPath(ctx, x, y, w, h, r) {
  if (h < r * 2) r = h / 2;
  if (w < r * 2) r = w / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawBars(canvas, days, valueGetter, opts) {
  if (!canvas) return;
  const setup = setupCanvas(canvas, opts.height || 140);
  if (!setup) return;
  const { ctx, w, h } = setup;

  const padL = 28, padR = 8, padT = 20, padB = 26;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  const accent = cssVar('--accent', '#7c6cf8');
  const accentH = cssVar('--accent-h', '#9b8cff');
  const muted = cssVar('--text-muted', '#7c7e9c');
  const textSec = cssVar('--text-sec', '#b6b7cf');

  const values = days.map(d => valueGetter(d));
  const max = Math.max(opts.minMax || 5, ...values);

  ctx.strokeStyle = 'rgba(128,128,128,.1)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padT + chartH * (i / 3);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }
  ctx.fillStyle = muted;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(opts.unit || '', padL - 6, padT - 8);
  ctx.fillText('0', padL - 6, padT + chartH);

  const slotW = chartW / days.length;
  const gap = Math.max(3, slotW * 0.3);
  const barW = Math.max(4, slotW - gap);

  days.forEach((d, i) => {
    const v = values[i];
    const x = padL + i * slotW + gap / 2;
    const ratio = max > 0 ? v / max : 0;
    const bh = Math.max(v > 0 ? 4 : 1, ratio * chartH);
    const y = padT + chartH - bh;

    if (v > 0) {
      const grad = ctx.createLinearGradient(0, y, 0, padT + chartH);
      grad.addColorStop(0, accentH);
      grad.addColorStop(1, accent);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = 'rgba(128,128,128,.15)';
    }
    roundRectPath(ctx, x, y, barW, bh, 3);
    ctx.fill();

    if (v > 0) {
      ctx.fillStyle = textSec;
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const txt = opts.fmt ? opts.fmt(v) : String(Math.round(v));
      ctx.fillText(txt, x + barW / 2, y - 3);
    }

    ctx.fillStyle = muted;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const dd = new Date(d.ds + 'T00:00:00');
    ctx.fillText(`${dd.getMonth() + 1}/${dd.getDate()}`, x + barW / 2, padT + chartH + 6);
  });
}

function drawDonut(canvas, slices, centerText) {
  if (!canvas) return;
  const setup = setupCanvas(canvas, 160);
  if (!setup) return;
  const { ctx, w, h } = setup;

  const size = Math.min(w, h);
  const cx = w / 2, cy = h / 2;
  const r = size / 2 - 12;
  const innerR = r * 0.62;

  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return;

  let startAngle = -Math.PI / 2;
  slices.forEach(s => {
    const angle = (s.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, startAngle + angle);
    ctx.arc(cx, cy, innerR, startAngle + angle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
    startAngle += angle;
  });

  const muted = cssVar('--text-muted', '#7c7e9c');
  const text = cssVar('--text', '#fff');
  ctx.fillStyle = muted;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(centerText.label, cx, cy - 8);

  ctx.fillStyle = text;
  ctx.font = 'bold 14px ' + cssVar('--mono', 'monospace');
  ctx.fillText(centerText.value, cx, cy + 8);
}

function getLast7Days() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(new Date(), -i);
    days.push({ ds: fmtD(d), date: d });
  }
  return days;
}

function drawTrendCharts() {
  if (!State.user) return;
  const days = getLast7Days();
  drawBars(document.getElementById('healthTrendSleep'), days, d => sumByOn('sleep', d.ds), {
    unit: '小时', height: 130, fmt: v => v.toFixed(1)
  });
  drawBars(document.getElementById('healthTrendExercise'), days, d => sumByOn('exercise', d.ds), {
    unit: '分钟', height: 130, fmt: v => String(Math.round(v))
  });
  drawBars(document.getElementById('healthTrendWater'), days, d => sumByOn('water', d.ds), {
    unit: 'ml', height: 130, fmt: v => String(Math.round(v))
  });
  drawBars(document.getElementById('healthTrendKcal'), days, d => {
    return DB.healthRecords
      .filter(r => r.user_id === State.user.id && r.date === d.ds && r.type === 'diet')
      .reduce((s, r) => s + (r.calories || r.value || 0), 0);
  }, {
    unit: 'kcal', height: 130, fmt: v => String(Math.round(v))
  });
}

function drawDietChart() {
  if (!State.user) return;
  const canvas = document.getElementById('healthDietChart');
  if (!canvas) return;

  const meals = [
    { key: 'breakfast', label: '🌅 早', color: '#f59e0b' },
    { key: 'lunch',     label: '🍚 午', color: '#7c6cf8' },
    { key: 'dinner',    label: '🌆 晚', color: '#3b82f6' },
    { key: 'snack',     label: '🍪 加', color: '#10b981' }
  ];
  const u = State.user.id;
  const recs = DB.healthRecords.filter(r => r.user_id === u && r.date === viewDate && r.type === 'diet');

  const slices = meals.map(m => ({
    label: m.label,
    color: m.color,
    value: recs.filter(r => r.meal === m.key).reduce((s, r) => s + (r.calories || 0), 0)
  }));

  const totalCal = slices.reduce((s, x) => s + x.value, 0);
  drawDonut(canvas, slices, {
    label: '卡路里',
    value: totalCal > 0 ? `${totalCal} kcal` : '0'
  });
}

/** ⭐ 营养素分布环（蛋白/碳水/脂肪） */
function drawNutritionChart() {
  if (!State.user) return;
  const canvas = document.getElementById('healthNutritionChart');
  if (!canvas) return;

  const n = sumNutritionOn(viewDate);
  /* 卡路里贡献：蛋白 4 kcal/g，碳水 4 kcal/g，脂肪 9 kcal/g */
  const pCal = n.protein * 4;
  const cCal = n.carb * 4;
  const fCal = n.fat * 9;
  const total = pCal + cCal + fCal;
  if (total <= 0) return;

  const slices = [
    { label: '蛋白', color: '#f472b6', value: pCal },
    { label: '碳水', color: '#fbbf24', value: cCal },
    { label: '脂肪', color: '#60a5fa', value: fCal }
  ];

  drawDonut(canvas, slices, {
    label: '总热量',
    value: `${Math.round(total)}`
  });
}

function drawSportChart() {
  if (!State.user) return;
  const canvas = document.getElementById('healthSportChart');
  if (!canvas) return;

  const u = State.user.id;
  const recs = DB.healthRecords.filter(r => r.user_id === u && r.date === viewDate && r.type === 'exercise');

  const byType = {};
  recs.forEach(r => {
    const k = r.sport || '其他';
    byType[k] = (byType[k] || 0) + (r.value || 0);
  });

  const COLORS = ['#7c6cf8', '#4ade80', '#fbbf24', '#f87171', '#60a5fa', '#f472b6', '#34d399', '#fb923c'];
  const slices = Object.keys(byType)
    .sort((a, b) => byType[b] - byType[a])
    .map((k, i) => ({ label: k, color: COLORS[i % COLORS.length], value: byType[k] }));

  const totalMin = slices.reduce((s, x) => s + x.value, 0);
  drawDonut(canvas, slices, {
    label: '运动',
    value: totalMin > 0 ? `${totalMin}分` : '0'
  });
}

function drawAllCharts() {
  try {
    drawTrendCharts();
    drawDietChart();
    drawSportChart();
    drawNutritionChart();
  } catch (e) {
    console.warn('[health] chart draw failed:', e);
  }
}

/* ============ 周统计 ============ */
function getWeekStats() {
  const u = State.user?.id;
  if (!u) return { sleep: 0, exCount: 0, water: 0, dietCount: 0, days: 0 };

  const ws = weekStart(new Date());
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = fmtD(addDays(ws, i));
    if (d > today()) break;
    days.push(d);
  }

  let sleepSum = 0, exCount = 0, waterSum = 0, dietCount = 0;
  days.forEach(d => {
    sleepSum += sumByOn('sleep', d);
    exCount += DB.healthRecords.filter(r => r.user_id === u && r.date === d && r.type === 'exercise').length;
    waterSum += sumByOn('water', d);
    dietCount += DB.healthRecords.filter(r => r.user_id === u && r.date === d && r.type === 'diet').length;
  });

  return {
    sleep: days.length ? +(sleepSum / days.length).toFixed(1) : 0,
    exCount,
    water: waterSum,
    dietCount,
    days: days.length
  };
}

/* ============ 渲染 ============ */
function renderCompare(cur, prev) {
  if (prev === 0 && cur === 0) return '';
  if (prev === 0) return `<span class="hsc-cmp up">↑ 新增</span>`;
  const d = cur - prev;
  if (d === 0) return `<span class="hsc-cmp flat">— 持平</span>`;
  const pct = Math.round(Math.abs(d) / prev * 100);
  if (d > 0) return `<span class="hsc-cmp up">↑ ${pct}%</span>`;
  return `<span class="hsc-cmp down">↓ ${pct}%</span>`;
}

function renderRing(pct, color) {
  const size = 60, stroke = 6, r = (size - stroke) / 2 - 1;
  const circ = 2 * Math.PI * r;
  const dash = circ * (Math.max(0, Math.min(100, pct)) / 100);
  return `
    <svg class="hsc-ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke-width="${stroke}" class="hsc-ring-track"/>
      <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke-width="${stroke}" stroke-linecap="round" stroke="${color}" stroke-dasharray="${dash.toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 ${size/2} ${size/2})"/>
    </svg>`;
}

function renderOverviewCard(opts) {
  const { icon, label, value, unit, cls, prevValue, goal, goalUnit, goalType, ring } = opts;

  let body;
  if (goal && goal > 0 && ring) {
    const pct = Math.min(100, Math.round((value / goal) * 100));
    body = `
      <div class="hsc-ring-wrap">
        ${renderRing(pct, 'var(--accent)')}
        <div class="hsc-ring-center">
          <div class="hsc-ring-pct">${pct}%</div>
        </div>
      </div>
      <div class="hsc-body">
        <div class="hsc-value">${value}<span class="hsc-unit">/${goal}${goalUnit || unit}</span></div>
        <div class="hsc-label">${label}</div>
      </div>`;
  } else {
    body = `
      <div class="hsc-body">
        <div class="hsc-value">${value}<span class="hsc-unit">${unit || ''}</span></div>
        <div class="hsc-label">${label}</div>
        ${renderCompare(value, prevValue || 0)}
      </div>`;
  }

  return `<div class="health-stat-card ${cls || ''}" data-action="health-goal-edit" data-type="${goalType || ''}">
    <div class="hsc-icon">${icon}</div>
    ${body}
  </div>`;
}

function renderOverview() {
  const o = getOverview(viewDate);
  const prevDate = fmtD(addDays(new Date(viewDate + 'T00:00:00'), -1));
  const po = getOverview(prevDate);

  const waterGoal = getGoal('water');
  const waterGoalMl = waterGoal ? waterGoal.target_value : 0;

  return `
    <div class="health-overview-grid">
      ${renderOverviewCard({
        icon: '😴', label: '睡眠', value: o.sleepSum, unit: '小时', cls: 'sleep',
        prevValue: po.sleepSum, goalType: 'sleep'
      })}
      ${renderOverviewCard({
        icon: '🏃', label: '运动', value: o.exercise, unit: '分钟', cls: 'exercise',
        prevValue: po.exercise, goalType: 'exercise'
      })}
      ${renderOverviewCard({
        icon: '💧', label: '饮水', value: o.water, unit: 'ml', cls: 'water',
        prevValue: po.water,
        goal: waterGoalMl, goalUnit: 'ml', goalType: 'water', ring: true
      })}
      ${renderOverviewCard({
        icon: '🍱', label: '饮食',
        value: o.calories > 0 ? o.calories : o.diet,
        unit: o.calories > 0 ? 'kcal' : '条',
        cls: 'diet',
        prevValue: po.calories > 0 ? po.calories : po.diet,
        goalType: 'diet'
      })}
    </div>`;
}

function renderDateBar() {
  const isToday = viewDate === today();
  const d = new Date(viewDate + 'T00:00:00');
  const weekday = '日一二三四五六'[d.getDay()];
  const label = isToday ? `今天 · ${viewDate}` : `${viewDate} 周${weekday}`;

  return `
    <div class="health-date-bar">
      <button class="btn btn-xs" data-action="health-date-prev" type="button">←</button>
      <div class="health-date-label">${label}</div>
      <button class="btn btn-xs" data-action="health-date-next" type="button">→</button>
      <input type="date" class="input health-date-input" id="healthDateInput" value="${viewDate}">
      ${!isToday ? `<button class="btn btn-xs btn-primary" data-action="health-date-today" type="button">今天</button>` : ''}
    </div>`;
}

function renderEnergyPanel() {
  const e = calcTodayEnergy();
  const netAbs = Math.abs(e.net);
  const netSign = e.net > 0 ? '盈余' : e.net < 0 ? '赤字' : '持平';
  const netCls = e.net > 0 ? 'surplus' : e.net < 0 ? 'deficit' : 'flat';
  const isToday = viewDate === today();

  let hint;
  if (e.net > 500) hint = `摄入比消耗多 <b>${netAbs}</b> kcal，减脂期建议控制在 +300 以内 🍽️`;
  else if (e.net > 0) hint = `小幅盈余 <b>${netAbs}</b> kcal，属于正常范围 ✅`;
  else if (e.net === 0) hint = '摄入与消耗持平，保持得很好 👍';
  else if (e.net > -500) hint = `小幅赤字 <b>${netAbs}</b> kcal，属于健康减脂区间 ✅`;
  else hint = `赤字 <b>${netAbs}</b> kcal，注意补充营养避免代谢下降 🥗`;

  return `
    <div class="panel">
      <div class="panel-title">
        <span class="title-icon">🔥</span>${isToday ? '今日' : viewDate} 热量
        <button class="btn btn-xs btn-ghost" data-action="health-energy-info" type="button" title="计算公式说明">ⓘ</button>
        <button class="btn btn-xs btn-ghost" data-action="health-ai-meal-plan" type="button" style="margin-left:auto" title="让 AI 根据数据给食谱建议">🤖 AI 食谱建议</button>
      </div>

      <div class="health-energy-grid">
        <div class="health-energy-cell intake">
          <div class="hec-icon">🍱</div>
          <div class="hec-value">${e.intake}</div>
          <div class="hec-label">摄入 kcal</div>
        </div>
        <div class="health-energy-cell burned">
          <div class="hec-icon">🔥</div>
          <div class="hec-value">${e.burned}</div>
          <div class="hec-label">总消耗 kcal</div>
          <div class="hec-sub">基础 ${e.baseBurn} · 运动 ${e.exerciseKcal} · TEF ${e.tef}</div>
        </div>
        <div class="health-energy-cell net ${netCls}">
          <div class="hec-icon">${e.net > 0 ? '📈' : e.net < 0 ? '📉' : '➖'}</div>
          <div class="hec-value">${netAbs}</div>
          <div class="hec-label">${netSign} kcal</div>
        </div>
      </div>

      <div class="health-energy-hint">${hint}</div>
    </div>`;
}

/* ⭐ 今日营养素面板 */
function renderNutritionPanel() {
  const n = sumNutritionOn(viewDate);
  const hasData = n.protein > 0 || n.carb > 0 || n.fat > 0;

  if (!hasData) {
    return `
      <div class="panel">
        <div class="panel-title"><span class="title-icon">🥗</span>今日营养素</div>
        <div class="done-empty" style="padding:14px;font-size:11.5px">
          记录饮食时填蛋白质/碳水/脂肪，或用 AI 估算
        </div>
      </div>`;
  }

  /* 三大营养素热量占比 */
  const pCal = n.protein * 4;
  const cCal = n.carb * 4;
  const fCal = n.fat * 9;
  const totalMacro = pCal + cCal + fCal;
  const pPct = totalMacro > 0 ? Math.round(pCal / totalMacro * 100) : 0;
  const cPct = totalMacro > 0 ? Math.round(cCal / totalMacro * 100) : 0;
  const fPct = totalMacro > 0 ? Math.round(fCal / totalMacro * 100) : 0;

  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">🥗</span>今日营养素</div>

      <div class="health-nutrition-grid">
        <div class="health-nutrition-cell p">
          <div class="hnc-label">蛋白质</div>
          <div class="hnc-value">${n.protein.toFixed(1)}<span class="hnc-unit">g</span></div>
          <div class="hnc-bar"><div class="hnc-bar-fill" style="width:${pPct}%"></div></div>
          <div class="hnc-pct">${pPct}% 热量占比</div>
        </div>
        <div class="health-nutrition-cell c">
          <div class="hnc-label">碳水</div>
          <div class="hnc-value">${n.carb.toFixed(1)}<span class="hnc-unit">g</span></div>
          <div class="hnc-bar"><div class="hnc-bar-fill" style="width:${cPct}%"></div></div>
          <div class="hnc-pct">${cPct}% 热量占比</div>
        </div>
        <div class="health-nutrition-cell f">
          <div class="hnc-label">脂肪</div>
          <div class="hnc-value">${n.fat.toFixed(1)}<span class="hnc-unit">g</span></div>
          <div class="hnc-bar"><div class="hnc-bar-fill" style="width:${fPct}%"></div></div>
          <div class="hnc-pct">${fPct}% 热量占比</div>
        </div>
      </div>

      <div class="health-nutrition-hint">
        💡 参考区间：蛋白 10-35% · 碳水 45-65% · 脂肪 20-35%
      </div>
    </div>`;
}

function renderGoalsPanel() {
  return `
    <div class="panel">
      <div class="panel-title">
        <span class="title-icon">🎯</span>健康目标
        <button class="btn btn-xs btn-ghost" data-action="health-goal-edit" data-type="" type="button" style="margin-left:auto">⚙️ 设置</button>
      </div>
      <div class="health-goal-list">
        ${GOAL_TYPES.map(t => {
          const g = getGoal(t.key);
          const cur = t.key === 'water' ? sumBy('water')
                    : t.key === 'sleep' ? +sumBy('sleep').toFixed(1)
                    : t.key === 'exercise' ? sumBy('exercise')
                    : 0;
          const pct = g && g.target_value > 0 ? Math.min(100, Math.round(cur / g.target_value * 100)) : 0;

          let linkTag = '';
          if (g && g.linkedType && g.linkedId) {
            if (g.linkedType === 'habit') {
              const h = DB.habits.find(x => x.id === g.linkedId);
              linkTag = h
                ? `<span class="hgi-link">🔗 习惯：${esc(h.name)}</span>`
                : `<span class="hgi-link warn">🔗 习惯已删除</span>`;
            } else if (g.linkedType === 'goal') {
              const go = DB.goals.find(x => x.id === g.linkedId);
              linkTag = go
                ? `<span class="hgi-link">🔗 目标：${esc(go.title)}</span>`
                : `<span class="hgi-link warn">🔗 目标已删除</span>`;
            }
          }

          return `
            <div class="health-goal-item" data-action="health-goal-edit" data-type="${t.key}">
              <span class="hgi-icon">${t.icon}</span>
              <div class="hgi-info">
                <div class="hgi-name">${t.name}</div>
                <div class="hgi-meta">${g ? `${cur} / ${g.target_value} ${g.unit}` : '未设置'}</div>
                ${g ? `<div class="hgi-bar"><div class="hgi-bar-fill" style="width:${pct}%"></div></div>` : ''}
                ${linkTag}
              </div>
              <span class="hgi-pct">${g ? pct + '%' : ''}</span>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

function renderChartsPanel() {
  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">📈</span>近 7 天趋势</div>
      <div class="health-charts-trend">
        <div class="health-chart-cell">
          <div class="health-chart-label">😴 睡眠 (小时)</div>
          <canvas id="healthTrendSleep" class="health-canvas"></canvas>
        </div>
        <div class="health-chart-cell">
          <div class="health-chart-label">🏃 运动 (分钟)</div>
          <canvas id="healthTrendExercise" class="health-canvas"></canvas>
        </div>
        <div class="health-chart-cell">
          <div class="health-chart-label">💧 饮水 (ml)</div>
          <canvas id="healthTrendWater" class="health-canvas"></canvas>
        </div>
        <div class="health-chart-cell">
          <div class="health-chart-label">🔥 卡路里 (kcal)</div>
          <canvas id="healthTrendKcal" class="health-canvas"></canvas>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title"><span class="title-icon">🍱</span>今日饮食 / 运动 / 营养素</div>
      <div class="health-charts-donut three">
        <div class="health-donut-cell">
          <canvas id="healthDietChart" class="health-canvas-donut"></canvas>
          <div class="health-donut-legend">
            <span class="hdl-item"><span class="hdl-dot" style="background:#f59e0b"></span>早</span>
            <span class="hdl-item"><span class="hdl-dot" style="background:#7c6cf8"></span>午</span>
            <span class="hdl-item"><span class="hdl-dot" style="background:#3b82f6"></span>晚</span>
            <span class="hdl-item"><span class="hdl-dot" style="background:#10b981"></span>加</span>
          </div>
        </div>
        <div class="health-donut-cell">
          <canvas id="healthNutritionChart" class="health-canvas-donut"></canvas>
          <div class="health-donut-legend">
            <span class="hdl-item"><span class="hdl-dot" style="background:#f472b6"></span>蛋白</span>
            <span class="hdl-item"><span class="hdl-dot" style="background:#fbbf24"></span>碳水</span>
            <span class="hdl-item"><span class="hdl-dot" style="background:#60a5fa"></span>脂肪</span>
          </div>
        </div>
        <div class="health-donut-cell">
          <canvas id="healthSportChart" class="health-canvas-donut"></canvas>
          <div class="health-donut-legend">
            <span style="color:var(--text-muted);font-size:11px">运动类型</span>
          </div>
        </div>
      </div>
    </div>`;
}

function renderWeekStats() {
  const s = getWeekStats();
  return `
    <div class="panel">
      <div class="panel-title"><span class="title-icon">📊</span>本周统计 <span style="font-size:11px;color:var(--text-muted);font-weight:600;margin-left:6px">已过 ${s.days} 天</span></div>
      <div class="health-week-grid">
        <div class="health-week-cell">
          <div class="hwk-icon">😴</div>
          <div class="hwk-value">${s.sleep}<span class="hwk-unit">h</span></div>
          <div class="hwk-label">平均睡眠</div>
        </div>
        <div class="health-week-cell">
          <div class="hwk-icon">🏃</div>
          <div class="hwk-value">${s.exCount}<span class="hwk-unit">次</span></div>
          <div class="hwk-label">运动次数</div>
        </div>
        <div class="health-week-cell">
          <div class="hwk-icon">💧</div>
          <div class="hwk-value">${s.water}<span class="hwk-unit">ml</span></div>
          <div class="hwk-label">饮水总量</div>
        </div>
        <div class="health-week-cell">
          <div class="hwk-icon">🍱</div>
          <div class="hwk-value">${s.dietCount}<span class="hwk-unit">条</span></div>
          <div class="hwk-label">饮食记录</div>
        </div>
      </div>
    </div>`;
}

function renderRecordItem(r) {
  const time = r.savedAt ? new Date(r.savedAt).toTimeString().slice(0, 5) : '';
  let icon = '📌', title = '记录', detail = '';

  if (r.type === 'sleep') {
    icon = '😴';
    title = `睡眠 ${r.value} 小时`;
    detail = [
      r.sleepAt ? `🌙 ${r.sleepAt}` : '',
      r.wakeAt ? `☀️ ${r.wakeAt}` : '',
      r.quality ? '⭐'.repeat(r.quality) : '',
      r.note || ''
    ].filter(Boolean).join(' · ');
  } else if (r.type === 'exercise') {
    icon = '🏃';
    const kcal = getExerciseKcal(r);
    title = `${r.sport || '运动'} ${r.value} 分钟`;
    detail = [
      kcal > 0 ? `🔥 ${kcal} kcal` : '',
      r.intensity ? `强度 ${r.intensity}` : '',
      r.note || ''
    ].filter(Boolean).join(' · ');
  } else if (r.type === 'water') {
    icon = '💧';
    title = `饮水 ${r.value} ml`;
    detail = r.note || '';
  } else if (r.type === 'diet') {
    icon = '🍱';
    const mealMap = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
    title = `${mealMap[r.meal] || '饮食'}${r.foods && r.foods.length ? ' · ' + r.foods.join('、') : ''}`;
    const macroParts = [];
    if (r.calories) macroParts.push(`${r.calories} kcal`);
    if (r.protein > 0 || r.carb > 0 || r.fat > 0) {
      macroParts.push(`P ${(+r.protein || 0).toFixed(1)} · C ${(+r.carb || 0).toFixed(1)} · F ${(+r.fat || 0).toFixed(1)}`);
    }
    if (r.note) macroParts.push(r.note);
    detail = macroParts.join(' · ');
  }

  return `<div class="health-record-item">
    <span class="hri-icon">${icon}</span>
    <div class="hri-body">
      <div class="hri-title">${esc(title)}</div>
      ${detail ? `<div class="hri-detail">${esc(detail)}</div>` : ''}
    </div>
    <span class="hri-time">${time}</span>
    <div class="hri-actions">
      <button class="btn btn-xs btn-ghost" data-action="health-edit" data-id="${r.id}" type="button" title="编辑">✎</button>
      <button class="btn btn-xs btn-danger" data-action="health-del" data-id="${r.id}" type="button" title="删除">✕</button>
    </div>
  </div>`;
}

function calcSleepHours(sleepAt, wakeAt) {
  if (!sleepAt || !wakeAt) return 0;
  const [sh, sm] = sleepAt.split(':').map(Number);
  const [wh, wm] = wakeAt.split(':').map(Number);
  let mins = (wh * 60 + wm) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return mins / 60;
}

function recordWater(ml, date) {
  const u = State.user.id;
  const d = date || viewDate;
  DB.healthRecords.push({
    id: uid(), user_id: u, date: d, type: 'water',
    value: ml, unit: 'ml',
    savedAt: new Date().toISOString()
  });
  save('healthRecords');
  syncMetricForDate('water', d);
  const total = sumByOn('water', d);
  toast(`💧 +${ml}ml，共 ${total} ml`, 'success');
  rerender();
}

function showEnergyInfoModal() {
  const e = calcTodayEnergy();
  const u = State.user;
  const w = u.weight || 60;
  const h = u.height || 170;
  const a = u.age || 25;
  const g = u.gender || 'male';

  const bmrFormula = g === 'female'
    ? `9.99 × ${w} + 6.25 × ${h} − 4.92 × ${a} − 161`
    : `9.99 × ${w} + 6.25 × ${h} − 4.92 × ${a} + 5`;

  showModal('energyInfoModal', `
    <h3 style="font-size:16px;margin-bottom:14px;font-weight:800">📐 热量计算公式说明</h3>

    <div style="font-size:12.5px;color:var(--text-sec);line-height:1.9">
      <div style="font-weight:800;color:var(--text);margin-bottom:6px">① 基础代谢 BMR</div>
      <div style="font-size:11.5px;padding-left:14px;color:var(--text-muted);line-height:1.7">
        公式：<b style="color:var(--accent);font-family:var(--mono)">Mifflin-St Jeor</b>（美国营养与饮食学会推荐标准）<br>
        <span style="font-family:var(--mono);color:var(--text)">${bmrFormula}</span><br>
        = <b style="color:var(--accent);font-family:var(--mono)">${e.bmr} kcal</b>
      </div>

      <div style="font-weight:800;color:var(--text);margin:14px 0 6px">② 日常活动消耗</div>
      <div style="font-size:11.5px;padding-left:14px;color:var(--text-muted);line-height:1.7">
        BMR × 活动系数（久坐 PAL = 1.2）<br>
        <span style="font-family:var(--mono);color:var(--text)">${e.bmr} × 1.2 = ${e.baseBurn} kcal</span>
      </div>

      <div style="font-weight:800;color:var(--text);margin:14px 0 6px">③ 运动净消耗</div>
      <div style="font-size:11.5px;padding-left:14px;color:var(--text-muted);line-height:1.7">
        <b style="color:var(--accent);font-family:var(--mono)">(METs − 1) × 体重kg × 时长h</b><br>
        METs 参考 2024 Compendium of Physical Activities<br>
        减 1 MET 扣除同时段静息代谢<br>
        今日运动消耗 = <b style="color:var(--accent);font-family:var(--mono)">${e.exerciseKcal} kcal</b>
      </div>

      <div style="font-weight:800;color:var(--text);margin:14px 0 6px">④ 食物热效应 TEF</div>
      <div style="font-size:11.5px;padding-left:14px;color:var(--text-muted);line-height:1.7">
        摄入 × 10%（消化吸收食物本身的耗能）<br>
        <span style="font-family:var(--mono);color:var(--text)">${e.intake} × 0.10 = ${e.tef} kcal</span>
      </div>

      <div style="font-weight:800;color:var(--text);margin:14px 0 6px">⑤ 营养素换算</div>
      <div style="font-size:11.5px;padding-left:14px;color:var(--text-muted);line-height:1.7">
        蛋白 4 kcal/g · 碳水 4 kcal/g · 脂肪 9 kcal/g
      </div>

      <div style="font-weight:800;color:var(--text);margin:14px 0 6px">⑥ 总消耗 & 净差</div>
      <div style="font-size:11.5px;padding-left:14px;color:var(--text-muted);line-height:1.7">
        总消耗 = ${e.baseBurn} + ${e.exerciseKcal} + ${e.tef} = <b style="color:var(--accent);font-family:var(--mono)">${e.burned} kcal</b><br>
        净差 = 摄入 − 总消耗 = ${e.intake} − ${e.burned} = <b style="color:var(--accent);font-family:var(--mono)">${e.net > 0 ? '+' : ''}${e.net} kcal</b>
      </div>

      <div style="margin-top:16px;padding:10px 14px;background:var(--bg-input);border-radius:10px;border-left:3px solid var(--info);font-size:11px;line-height:1.7">
        ⚠️ <b>免责声明</b>：以上为估算值，实际消耗因个体差异（肌肉量、代谢适应性、激素水平等）会有偏差。若需精确方案请咨询专业营养师或医生。
      </div>
    </div>

    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-sm" data-action="modal-close" type="button">关闭</button>
    </div>
  `, 'lg');
}

/* ============ 模块导出 ============ */
export default {
  id: 'health',
  name: '健康',
  icon: '💚',
  order: 35,

  render() {
    const records = recordsOn(viewDate);
    const isToday = viewDate === today();

    return `
      <div class="home-grid">
        ${renderDateBar()}
        ${renderOverview()}
        ${renderEnergyPanel()}
        ${renderNutritionPanel()}
        ${renderWeekStats()}

        <div class="panel">
          <div class="panel-title">
            <span class="title-icon">➕</span>快捷记录${!isToday ? ` <span style="font-size:11px;color:var(--text-muted);font-weight:600;margin-left:6px">（补记 ${viewDate}）</span>` : ''}
          </div>
          <div class="health-quick-grid">
            <button class="health-quick-btn sleep" data-action="health-add-sleep" type="button">
              <span class="hqb-icon">😴</span>
              <span class="hqb-text">记录睡眠</span>
            </button>
            <button class="health-quick-btn exercise" data-action="health-add-exercise" type="button">
              <span class="hqb-icon">🏃</span>
              <span class="hqb-text">记录运动</span>
            </button>
            <button class="health-quick-btn water" data-action="health-add-water" type="button">
              <span class="hqb-icon">💧</span>
              <span class="hqb-text">记录饮水</span>
            </button>
            <button class="health-quick-btn diet" data-action="health-add-diet" type="button">
              <span class="hqb-icon">🍱</span>
              <span class="hqb-text">记录饮食</span>
            </button>
          </div>
        </div>

        ${renderChartsPanel()}
        ${renderGoalsPanel()}

        <div class="panel">
          <div class="panel-title">
            <span class="title-icon">📋</span>${isToday ? '今日记录' : viewDate + ' 记录'}
            <span style="margin-left:auto;font-size:11.5px;color:var(--text-muted);font-weight:700">${records.length} 条</span>
          </div>
          <div id="healthTodayList">
            ${records.length
              ? records.map(renderRecordItem).join('')
              : '<div class="done-empty">这天还没有记录，点上面的按钮开始 💚</div>'}
          </div>
        </div>
      </div>`;
  },

  mounted() {
    setTimeout(() => {
      const inp = document.getElementById('healthDateInput');
      if (inp) {
        inp.addEventListener('change', () => {
          if (inp.value && inp.value !== viewDate) {
            viewDate = inp.value;
            rerender();
          }
        });
      }
      requestAnimationFrame(() => {
        setTimeout(() => drawAllCharts(), 30);
      });
    }, 60);
  },

  actions: {
    'health-date-prev': () => {
      viewDate = fmtD(addDays(new Date(viewDate + 'T00:00:00'), -1));
      rerender();
    },
    'health-date-next': () => {
      const next = fmtD(addDays(new Date(viewDate + 'T00:00:00'), 1));
      if (next > today()) { toast('不能查看未来', 'info'); return; }
      viewDate = next;
      rerender();
    },
    'health-date-today': () => {
      viewDate = today();
      rerender();
    },

    'health-energy-info': () => {
      showEnergyInfoModal();
    },

    'health-ai-meal-plan': async () => {
      const { AIHub } = await import('../diary/ai.js');
      if (!AIHub.isEnabled()) { toast('请先到设置启用 AI', 'warning'); return; }

      showModal('mealPlanGoal', `
        <h3 style="font-size:16px;margin-bottom:6px;font-weight:800">🤖 AI 食谱建议</h3>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;line-height:1.6">
          AI 会根据你的身体数据、今日摄入/消耗，生成一份个性化食谱。
        </div>

        <label class="hm-label">今天的目的</label>
        <div class="health-meal-row" id="mealPlanGoalRow" style="margin-bottom:16px">
          <button class="meal-chip active" data-goal="cut" type="button">🔥 减脂</button>
          <button class="meal-chip" data-goal="maintain" type="button">⚖️ 维持</button>
          <button class="meal-chip" data-goal="bulk" type="button">💪 增肌</button>
        </div>
        <input type="hidden" id="mealPlanGoal" value="cut">

        <div class="modal-actions">
          <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
          <button class="btn btn-sm btn-primary" data-action="health-ai-meal-plan-run" type="button">生成</button>
        </div>
      `);
      setTimeout(() => {
        document.querySelectorAll('#mealPlanGoalRow .meal-chip').forEach(b => {
          b.addEventListener('click', () => {
            document.getElementById('mealPlanGoal').value = b.dataset.goal;
            document.querySelectorAll('#mealPlanGoalRow .meal-chip').forEach(x => x.classList.toggle('active', x === b));
          });
        });
      }, 60);
    },

    'health-ai-meal-plan-run': async () => {
      const goal = document.getElementById('mealPlanGoal').value || 'cut';
      hideModal();

      showModal('mealPlanLoading', `
        <h3 style="font-size:16px;margin-bottom:16px;font-weight:800">🤖 AI 生成食谱中…</h3>
        <div class="ai-loading" style="padding:30px;text-align:center">
          <div style="font-size:32px;margin-bottom:8px">🥗</div>
          <div>正在根据你的数据生成食谱…</div>
        </div>
      `);

      try {
        const { AIHub } = await import('../diary/ai.js');
        const energy = calcTodayEnergy();
        const nutrition = sumNutritionOn(viewDate);
        const text = await AIHub.generateMealPlan({
          goal,
          profile: {
            weight: State.user.weight,
            height: State.user.height,
            gender: State.user.gender,
            age: State.user.age
          },
          energy,
          nutrition
        });
        hideModal();
        showModal('mealPlanResult', `
          <h3 style="font-size:16px;margin-bottom:14px;font-weight:800">🥗 AI 食谱建议</h3>
          <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:10px">
            目的：${{cut:'🔥 减脂', maintain:'⚖️ 维持', bulk:'💪 增肌'}[goal]} · 今日净${energy.net > 0 ? '盈余' : '赤字'} ${Math.abs(energy.net)} kcal
            ${nutrition.protein > 0 || nutrition.carb > 0 || nutrition.fat > 0 ? ` · 已摄入 P${nutrition.protein.toFixed(0)}/C${nutrition.carb.toFixed(0)}/F${nutrition.fat.toFixed(0)}g` : ''}
          </div>
          <div style="font-size:13px;color:var(--text-sec);line-height:1.9;white-space:pre-wrap;background:var(--bg-input);padding:16px;border-radius:12px;border:1px solid var(--border);max-height:55vh;overflow-y:auto">${esc(text)}</div>
          <div class="health-hint-box" style="margin-top:12px;font-size:11px">
            ⚠️ AI 建议仅供参考，不构成医疗或营养专业建议。特殊体质请咨询医生。
          </div>
          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
            <button class="btn btn-sm" data-action="health-copy-meal-plan" data-text="${esc(text)}" type="button">📋 复制</button>
            <button class="btn btn-sm" data-action="modal-close" type="button">关闭</button>
          </div>
        `, 'lg');
      } catch (e) {
        hideModal();
        toast('生成失败：' + e.message, 'error');
      }
    },

    'health-copy-meal-plan': (el) => {
      const text = el.dataset.text || '';
      navigator.clipboard.writeText(text).then(
        () => toast('已复制到剪贴板', 'success'),
        () => toast('复制失败', 'error')
      );
    },

    /* ===== 睡眠 ===== */
    'health-add-sleep': () => {
      const now = new Date();
      const defaultWake = now.toTimeString().slice(0, 5);
      const defaultSleep = (() => {
        const d = new Date(now.getTime() - 7.5 * 3600 * 1000);
        return d.toTimeString().slice(0, 5);
      })();

      showModal('healthSleepModal', `
        <h3 style="font-size:16px;margin-bottom:14px;font-weight:800">😴 记录睡眠 · ${viewDate}</h3>
        <div style="display:flex;gap:10px;margin-bottom:12px">
          <div style="flex:1">
            <label class="hm-label">🌙 入睡时间</label>
            <input type="time" class="input" id="hsSleepAt" value="${defaultSleep}">
          </div>
          <div style="flex:1">
            <label class="hm-label">☀️ 起床时间</label>
            <input type="time" class="input" id="hsWakeAt" value="${defaultWake}">
          </div>
        </div>
        <div style="margin-bottom:12px">
          <label class="hm-label">😊 睡眠质量</label>
          <div class="health-quality-row" id="hsQualityRow">
            ${[1,2,3,4,5].map(n => `<button class="quality-btn${n <= 3 ? ' active' : ''}" data-val="${n}" type="button">⭐</button>`).join('')}
          </div>
          <input type="hidden" id="hsQuality" value="3">
        </div>
        <div style="margin-bottom:12px">
          <label class="hm-label">📝 备注（可选）</label>
          <input type="text" class="input" id="hsNote" placeholder="做梦了吗 / 中途醒来…">
        </div>
        <div class="health-hint-box" id="hsPreview">
          预计时长：<b>${calcSleepHours(defaultSleep, defaultWake).toFixed(1)}</b> 小时
        </div>
        <div class="modal-actions">
          <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
          <button class="btn btn-sm btn-primary" data-action="health-save-sleep" type="button">保存</button>
        </div>
      `);

      setTimeout(() => {
        const refresh = () => {
          const p = document.getElementById('hsPreview');
          if (!p) return;
          const a = document.getElementById('hsSleepAt').value;
          const b = document.getElementById('hsWakeAt').value;
          p.innerHTML = `预计时长：<b>${calcSleepHours(a, b).toFixed(1)}</b> 小时`;
        };
        ['hsSleepAt','hsWakeAt'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.addEventListener('change', refresh);
        });
        document.querySelectorAll('#hsQualityRow .quality-btn').forEach(b => {
          b.addEventListener('click', () => {
            const v = parseInt(b.dataset.val);
            document.getElementById('hsQuality').value = v;
            document.querySelectorAll('#hsQualityRow .quality-btn').forEach(x => {
              x.classList.toggle('active', parseInt(x.dataset.val) <= v);
            });
          });
        });
      }, 60);
    },

    'health-save-sleep': () => {
      const sleepAt = document.getElementById('hsSleepAt').value;
      const wakeAt = document.getElementById('hsWakeAt').value;
      const quality = parseInt(document.getElementById('hsQuality').value) || 0;
      const note = document.getElementById('hsNote').value.trim();

      if (!sleepAt || !wakeAt) { toast('请填写入睡和起床时间', 'warning'); return; }
      const hours = calcSleepHours(sleepAt, wakeAt);
      if (hours <= 0 || hours > 24) { toast('时间不合理', 'warning'); return; }

      const u = State.user.id;
      DB.healthRecords.push({
        id: uid(), user_id: u, date: viewDate, type: 'sleep',
        value: +hours.toFixed(1),
        sleepAt, wakeAt, quality, note,
        savedAt: new Date().toISOString()
      });
      save('healthRecords');
      syncMetricForDate('sleep', viewDate);
      hideModal();
      toast(`已记录睡眠 ${hours.toFixed(1)} 小时`, 'success');
      rerender();
    },

    /* ===== 运动 ===== */
    'health-add-exercise': () => {
      const SPORTS = ['跑步','健身','骑行','游泳','瑜伽','球类','散步','其他'];
      showModal('healthExerciseModal', `
        <h3 style="font-size:16px;margin-bottom:14px;font-weight:800">🏃 记录运动 · ${viewDate}</h3>
        <div style="margin-bottom:12px">
          <label class="hm-label">项目</label>
          <div class="health-sport-row" id="heSportRow">
            ${SPORTS.map((s, i) => `<button class="sport-chip${i === 0 ? ' active' : ''}" data-sport="${s}" type="button">${s}</button>`).join('')}
          </div>
          <input type="hidden" id="heSport" value="${SPORTS[0]}">
        </div>
        <div style="display:flex;gap:10px;margin-bottom:12px">
          <div style="flex:1">
            <label class="hm-label">时长（分钟）</label>
            <input type="number" class="input" id="heValue" value="30" min="1" step="5">
          </div>
          <div style="flex:1">
            <label class="hm-label">强度</label>
            <select class="input" id="heIntensity">
              <option value="low">轻</option>
              <option value="medium" selected>中</option>
              <option value="high">重</option>
            </select>
          </div>
        </div>
        <div class="health-hint-box" id="heKcalPreview" style="margin-bottom:12px">
          预估消耗：<b>--</b> kcal
        </div>
        <div style="margin-bottom:12px">
          <label class="hm-label">备注（可选）</label>
          <input type="text" class="input" id="heNote" placeholder="跑步距离 / 感受…">
        </div>
        <div class="modal-actions">
          <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
          <button class="btn btn-sm btn-primary" data-action="health-save-exercise" type="button">保存</button>
        </div>
      `);

      setTimeout(() => {
        const refreshKcal = () => {
          const sport = document.getElementById('heSport').value;
          const value = parseFloat(document.getElementById('heValue').value) || 0;
          const intensity = document.getElementById('heIntensity').value;
          const preview = document.getElementById('heKcalPreview');
          if (!preview) return;
          const kcal = getExerciseKcal({ type: 'exercise', sport, value, intensity });
          preview.innerHTML = `预估消耗：<b>${kcal}</b> kcal`;
        };
        document.querySelectorAll('#heSportRow .sport-chip').forEach(b => {
          b.addEventListener('click', () => {
            document.getElementById('heSport').value = b.dataset.sport;
            document.querySelectorAll('#heSportRow .sport-chip').forEach(x => x.classList.toggle('active', x === b));
            refreshKcal();
          });
        });
        ['heValue', 'heIntensity'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.addEventListener('input', refreshKcal);
          if (el) el.addEventListener('change', refreshKcal);
        });
        refreshKcal();
      }, 60);
    },

    'health-save-exercise': () => {
      const sport = document.getElementById('heSport').value || '运动';
      const value = parseFloat(document.getElementById('heValue').value) || 0;
      const intensity = document.getElementById('heIntensity').value;
      const note = document.getElementById('heNote').value.trim();
      if (value <= 0) { toast('请输入时长', 'warning'); return; }

      const u = State.user.id;
      DB.healthRecords.push({
        id: uid(), user_id: u, date: viewDate, type: 'exercise',
        value, unit: '分钟',
        sport, intensity, note,
        savedAt: new Date().toISOString()
      });
      save('healthRecords');
      syncMetricForDate('exercise', viewDate);
      hideModal();
      const kcal = getExerciseKcal({ type: 'exercise', sport, value, intensity });
      toast(`已记录 ${sport} ${value} 分钟（约 ${kcal} kcal）`, 'success');
      rerender();
    },

    /* ===== 饮水 ===== */
    'health-add-water': () => {
      const todayTotal = sumBy('water');
      showModal('healthWaterModal', `
        <h3 style="font-size:16px;margin-bottom:6px;font-weight:800">💧 记录饮水 · ${viewDate}</h3>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px">
          这天已喝 <b style="color:var(--accent);font-family:var(--mono)">${todayTotal}</b> ml
        </div>

        <label class="hm-label">常用</label>
        <div class="health-meal-row" id="hwPresetRow" style="margin-bottom:14px">
          ${WATER_PRESETS.map(v =>
            `<button class="meal-chip${v === 250 ? ' active' : ''}" data-action="health-preset-water" data-val="${v}" type="button">+${v} ml</button>`
          ).join('')}
        </div>

        <label class="hm-label">自定义（ml）</label>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
          <input type="number" class="input" id="hwValue" value="250" min="1" max="2000" step="50" style="flex:1">
          <span style="font-size:12px;color:var(--text-muted);font-weight:700">ml</span>
        </div>

        <div class="modal-actions">
          <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
          <button class="btn btn-sm btn-primary" data-action="health-save-water" type="button">保存</button>
        </div>
      `);

      setTimeout(() => {
        const inp = document.getElementById('hwValue');
        if (inp) { inp.focus(); inp.select(); }
      }, 80);
    },

    'health-preset-water': (el) => {
      const v = parseInt(el.dataset.val) || 0;
      if (v <= 0) return;
      recordWater(v, viewDate);
      hideModal();
    },

    'health-save-water': () => {
      const inp = document.getElementById('hwValue');
      const v = inp ? Math.round(parseFloat(inp.value) || 0) : 0;
      if (v <= 0) { toast('请输入大于 0 的数值', 'warning'); return; }
      if (v > 2000) { toast('单次不要超过 2000ml 哦', 'warning'); return; }
      recordWater(v, viewDate);
      hideModal();
    },

    /* ===== 饮食 ===== */
    'health-add-diet': () => {
      const now = new Date();
      const h = now.getHours();
      let defaultMeal = 'lunch';
      if (h < 10) defaultMeal = 'breakfast';
      else if (h < 15) defaultMeal = 'lunch';
      else if (h < 21) defaultMeal = 'dinner';
      else defaultMeal = 'snack';

      const MEALS = [
        ['breakfast', '🌅 早餐'],
        ['lunch', '🍚 午餐'],
        ['dinner', '🌆 晚餐'],
        ['snack', '🍪 加餐']
      ];

      showModal('healthDietModal', `
        <h3 style="font-size:16px;margin-bottom:14px;font-weight:800">🍱 记录饮食 · ${viewDate}</h3>
        <div style="margin-bottom:12px">
          <label class="hm-label">餐次</label>
          <div class="health-meal-row" id="hdMealRow">
            ${MEALS.map(([k, label]) => `<button class="meal-chip${k === defaultMeal ? ' active' : ''}" data-meal="${k}" type="button">${label}</button>`).join('')}
          </div>
          <input type="hidden" id="hdMeal" value="${defaultMeal}">
        </div>
        <div style="margin-bottom:8px">
          <label class="hm-label">食物（用逗号分隔）</label>
          <input type="text" class="input" id="hdFoods" placeholder="如：米饭、番茄炒蛋、青菜">
        </div>
        <div style="margin-bottom:12px">
          <label class="hm-label" style="margin-bottom:6px">快捷添加</label>
          <div class="health-meal-row" id="hdFoodChips">
            ${DIET_FOOD_PRESETS.map(f => `<button class="meal-chip" data-food="${f}" type="button">${f}</button>`).join('')}
          </div>
        </div>

        <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
          <label class="hm-label" style="margin-bottom:0">营养（可选，AI 可一次填全）</label>
          <button class="btn btn-sm" data-action="health-ai-estimate-nutrition" type="button" title="让 AI 估算热量和营养素">🤖 AI 估算</button>
        </div>
        <div class="health-diet-inputs">
          <div class="health-diet-input-cell">
            <label>🔥 热量</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input type="number" class="input" id="hdCalories" placeholder="0" min="0">
              <span class="unit">kcal</span>
            </div>
          </div>
          <div class="health-diet-input-cell">
            <label>🥩 蛋白质</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input type="number" class="input" id="hdProtein" placeholder="0" min="0" step="0.1">
              <span class="unit">g</span>
            </div>
          </div>
          <div class="health-diet-input-cell">
            <label>🌾 碳水</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input type="number" class="input" id="hdCarb" placeholder="0" min="0" step="0.1">
              <span class="unit">g</span>
            </div>
          </div>
          <div class="health-diet-input-cell">
            <label>🥑 脂肪</label>
            <div style="display:flex;align-items:center;gap:4px">
              <input type="number" class="input" id="hdFat" placeholder="0" min="0" step="0.1">
              <span class="unit">g</span>
            </div>
          </div>
        </div>

        <div style="margin-bottom:12px;margin-top:12px">
          <label class="hm-label">备注（可选）</label>
          <input type="text" class="input" id="hdNote" placeholder="吃多了 / 有点辣…">
        </div>
        <div class="modal-actions">
          <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
          <button class="btn btn-sm btn-primary" data-action="health-save-diet" type="button">保存</button>
        </div>
      `);

      setTimeout(() => {
        document.querySelectorAll('#hdMealRow .meal-chip').forEach(b => {
          b.addEventListener('click', () => {
            document.getElementById('hdMeal').value = b.dataset.meal;
            document.querySelectorAll('#hdMealRow .meal-chip').forEach(x => x.classList.toggle('active', x === b));
          });
        });
        const foodsInp = document.getElementById('hdFoods');
        document.querySelectorAll('#hdFoodChips .meal-chip').forEach(b => {
          b.addEventListener('click', () => {
            const f = b.dataset.food;
            const cur = foodsInp.value.trim();
            const arr = cur ? cur.split(/[,，、;；]/).map(s => s.trim()).filter(Boolean) : [];
            if (!arr.includes(f)) arr.push(f);
            foodsInp.value = arr.join('、');
            b.classList.add('active');
          });
        });
      }, 60);
    },

    /* ⭐ AI 一次估算 4 个字段 */
    'health-ai-estimate-nutrition': async () => {
      const foodsText = document.getElementById('hdFoods').value.trim();
      if (!foodsText) { toast('请先填写食物', 'warning'); return; }

      const { AIHub } = await import('../diary/ai.js');
      if (!AIHub.isEnabled()) { toast('请先到设置启用 AI', 'warning'); return; }

      const btn = document.querySelector('[data-action="health-ai-estimate-nutrition"]');
      const oldText = btn ? btn.textContent : '';
      if (btn) { btn.textContent = '🤖…'; btn.disabled = true; }

      try {
        const r = await AIHub.estimateFoodNutrition(foodsText);
        const setVal = (id, v) => {
          const el = document.getElementById(id);
          if (el) el.value = v != null && v > 0 ? v : '';
        };
        setVal('hdCalories', r.calories);
        setVal('hdProtein', r.protein);
        setVal('hdCarb', r.carb);
        setVal('hdFat', r.fat);
        toast(`AI 估算：${r.calories} kcal · P${r.protein} / C${r.carb} / F${r.fat}`, 'success', { duration: 4000 });
      } catch (e) {
        toast('估算失败：' + e.message, 'error');
      } finally {
        if (btn) { btn.textContent = oldText; btn.disabled = false; }
      }
    },

    'health-save-diet': () => {
      const meal = document.getElementById('hdMeal').value;
      const foodsText = document.getElementById('hdFoods').value.trim();
      const calories = parseFloat(document.getElementById('hdCalories').value) || 0;
      const protein = parseFloat(document.getElementById('hdProtein').value) || 0;
      const carb = parseFloat(document.getElementById('hdCarb').value) || 0;
      const fat = parseFloat(document.getElementById('hdFat').value) || 0;
      const note = document.getElementById('hdNote').value.trim();

      if (!foodsText && !note && !calories && !protein && !carb && !fat) {
        toast('至少填一项内容', 'warning');
        return;
      }
      const foods = foodsText
        ? foodsText.split(/[,，、;；]/).map(s => s.trim()).filter(Boolean)
        : [];

      const u = State.user.id;
      DB.healthRecords.push({
        id: uid(), user_id: u, date: viewDate, type: 'diet',
        meal, foods, calories, protein, carb, fat, note,
        value: calories || 0,
        unit: calories ? 'kcal' : '',
        savedAt: new Date().toISOString()
      });
      save('healthRecords');
      /* ⭐ 同步 4 个指标 */
      syncDietAll(viewDate);
      emit('db:changed');
      hideModal();
      toast('已记录饮食', 'success');
      rerender();
    },

    /* ===== 编辑 ===== */
    'health-edit': (el, e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      const r = DB.healthRecords.find(x => x.id === el.dataset.id && x.user_id === State.user.id);
      if (!r) return;

      let fieldsHtml = '';
      if (r.type === 'sleep') {
        fieldsHtml = `
          <div style="display:flex;gap:10px;margin-bottom:12px">
            <div style="flex:1">
              <label class="hm-label">🌙 入睡</label>
              <input type="time" class="input" id="heSleepAt" value="${r.sleepAt || ''}">
            </div>
            <div style="flex:1">
              <label class="hm-label">☀️ 起床</label>
              <input type="time" class="input" id="heWakeAt" value="${r.wakeAt || ''}">
            </div>
          </div>
          <div style="margin-bottom:12px">
            <label class="hm-label">质量</label>
            <select class="input" id="heQuality">
              ${[1,2,3,4,5].map(n => `<option value="${n}"${r.quality === n ? ' selected' : ''}>${'⭐'.repeat(n)}</option>`).join('')}
            </select>
          </div>`;
      } else if (r.type === 'exercise') {
        fieldsHtml = `
          <div style="display:flex;gap:10px;margin-bottom:12px">
            <div style="flex:1">
              <label class="hm-label">项目</label>
              <input type="text" class="input" id="heSport" value="${esc(r.sport || '')}">
            </div>
            <div style="flex:1">
              <label class="hm-label">时长（分钟）</label>
              <input type="number" class="input" id="heValue" value="${r.value}" min="1">
            </div>
          </div>
          <div style="margin-bottom:12px">
            <label class="hm-label">强度</label>
            <select class="input" id="heIntensity">
              <option value="low"${r.intensity === 'low' ? ' selected' : ''}>轻</option>
              <option value="medium"${r.intensity === 'medium' ? ' selected' : ''}>中</option>
              <option value="high"${r.intensity === 'high' ? ' selected' : ''}>重</option>
            </select>
          </div>`;
      } else if (r.type === 'water') {
        fieldsHtml = `
          <div style="margin-bottom:12px">
            <label class="hm-label">毫升</label>
            <input type="number" class="input" id="heValue" value="${r.value}" min="1">
          </div>`;
      } else if (r.type === 'diet') {
        fieldsHtml = `
          <div style="margin-bottom:12px">
            <label class="hm-label">食物</label>
            <input type="text" class="input" id="heFoods" value="${esc((r.foods || []).join('、'))}">
          </div>
          <div class="health-diet-inputs">
            <div class="health-diet-input-cell">
              <label>🔥 热量</label>
              <div style="display:flex;align-items:center;gap:4px">
                <input type="number" class="input" id="heCalories" value="${r.calories || ''}" min="0">
                <span class="unit">kcal</span>
              </div>
            </div>
            <div class="health-diet-input-cell">
              <label>🥩 蛋白质</label>
              <div style="display:flex;align-items:center;gap:4px">
                <input type="number" class="input" id="heProtein" value="${r.protein || ''}" min="0" step="0.1">
                <span class="unit">g</span>
              </div>
            </div>
            <div class="health-diet-input-cell">
              <label>🌾 碳水</label>
              <div style="display:flex;align-items:center;gap:4px">
                <input type="number" class="input" id="heCarb" value="${r.carb || ''}" min="0" step="0.1">
                <span class="unit">g</span>
              </div>
            </div>
            <div class="health-diet-input-cell">
              <label>🥑 脂肪</label>
              <div style="display:flex;align-items:center;gap:4px">
                <input type="number" class="input" id="heFat" value="${r.fat || ''}" min="0" step="0.1">
                <span class="unit">g</span>
              </div>
            </div>
          </div>`;
      }

      showModal('healthEditModal', `
        <h3 style="font-size:16px;margin-bottom:14px;font-weight:800">✎ 编辑记录 · ${viewDate}</h3>
        ${fieldsHtml}
        <div style="margin-bottom:12px;margin-top:12px">
          <label class="hm-label">备注</label>
          <input type="text" class="input" id="heNote" value="${esc(r.note || '')}">
        </div>
        <div class="modal-actions">
          <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
          <button class="btn btn-sm btn-primary" data-action="health-save-edit" data-id="${r.id}" type="button">保存</button>
        </div>
      `, 'lg');
    },

    'health-save-edit': (el) => {
      const r = DB.healthRecords.find(x => x.id === el.dataset.id && x.user_id === State.user.id);
      if (!r) { hideModal(); return; }

      const get = id => document.getElementById(id);
      const note = get('heNote')?.value.trim() ?? r.note;

      if (r.type === 'sleep') {
        const sleepAt = get('heSleepAt').value;
        const wakeAt = get('heWakeAt').value;
        const hours = calcSleepHours(sleepAt, wakeAt);
        if (hours <= 0 || hours > 24) { toast('时间不合理', 'warning'); return; }
        r.sleepAt = sleepAt; r.wakeAt = wakeAt;
        r.quality = parseInt(get('heQuality').value) || 0;
        r.value = +hours.toFixed(1);
        r.note = note;
        save('healthRecords');
        syncMetricForDate('sleep', r.date);
      } else if (r.type === 'exercise') {
        const v = parseFloat(get('heValue').value);
        if (v <= 0) { toast('时长不合理', 'warning'); return; }
        r.sport = get('heSport').value.trim() || '运动';
        r.value = v;
        r.intensity = get('heIntensity').value;
        r.note = note;
        save('healthRecords');
        syncMetricForDate('exercise', r.date);
      } else if (r.type === 'water') {
        const v = parseFloat(get('heValue').value);
        if (v <= 0) { toast('数值不合理', 'warning'); return; }
        r.value = v;
        r.note = note;
        save('healthRecords');
        syncMetricForDate('water', r.date);
      } else if (r.type === 'diet') {
        const foodsText = get('heFoods').value.trim();
        r.foods = foodsText ? foodsText.split(/[,，、;；]/).map(s => s.trim()).filter(Boolean) : [];
        r.calories = parseFloat(get('heCalories').value) || 0;
        r.protein = parseFloat(get('heProtein').value) || 0;
        r.carb = parseFloat(get('heCarb').value) || 0;
        r.fat = parseFloat(get('heFat').value) || 0;
        r.value = r.calories;
        r.unit = r.calories ? 'kcal' : '';
        r.note = note;
        save('healthRecords');
        syncDietAll(r.date);
      }

      hideModal();
      toast('已保存', 'success');
      rerender();
    },

    'health-del': (el, e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      const r = DB.healthRecords.find(x => x.id === el.dataset.id && x.user_id === State.user.id);
      if (!r) return;
      if (!confirm('删除这条记录？')) return;

      const type = r.type;
      const date = r.date;

      const removed = snapshotDelete('healthRecords', el.dataset.id);
      if (!removed) return;

      save('healthRecords');
      if (type === 'diet') syncDietAll(date);
      else syncMetricForDate(type, date);
      rerender();

      toast('已删除记录', 'success', {
        actions: [{
          label: '撤销',
          onClick: () => {
            if (undo()) {
              if (type === 'diet') syncDietAll(date);
              else syncMetricForDate(type, date);
              emit('db:changed');
              toast('已恢复记录', 'success');
              rerender();
            }
          }
        }]
      });
    },

    'health-goal-edit': (el, e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      const type = el.dataset.type || '';
      const typesToEdit = type ? GOAL_TYPES.filter(t => t.key === type) : GOAL_TYPES;

      const availableGoals = DB.goals.filter(g =>
        g.user_id === State.user.id && !g.completed && g.type === 'quant'
      );
      const availableHabits = DB.habits.filter(h => h.user_id === State.user.id);

      const fieldsHtml = typesToEdit.map(t => {
        const g = getGoal(t.key);
        const linkedType = g?.linkedType || '';
        const linkedId = g?.linkedId || '';

        const goalOptions = availableGoals.map(go =>
          `<option value="${go.id}"${linkedId === go.id ? ' selected' : ''}>${esc(go.title)} [${go.target_total || '?'}${go.unit || ''}]</option>`
        ).join('');
        const habitOptions = availableHabits.map(h =>
          `<option value="${h.id}"${linkedId === h.id ? ' selected' : ''}>${esc(h.name)}</option>`
        ).join('');

        return `
          <div class="health-goal-edit-block" data-type="${t.key}">
            <div class="health-goal-edit-row">
              <span class="hge-icon">${t.icon}</span>
              <span class="hge-name">${t.name}</span>
              <input type="number" class="input hge-input" data-type="${t.key}" data-unit="${t.unit}" value="${g ? g.target_value : ''}" placeholder="留空=无目标" min="0">
              <span class="hge-unit">${t.unit}</span>
            </div>
            <div class="health-goal-link-row">
              <span class="hgl-label">🔗 绑定到</span>
              <select class="input hgl-type" data-type="${t.key}">
                <option value=""${!linkedType ? ' selected' : ''}>不绑定</option>
                <option value="habit"${linkedType === 'habit' ? ' selected' : ''}>习惯</option>
                <option value="goal"${linkedType === 'goal' ? ' selected' : ''}>目标</option>
              </select>
              <select class="input hgl-id" data-type="${t.key}" data-for="habit" style="display:${linkedType === 'habit' ? '' : 'none'}">
                <option value="">— 选择习惯 —</option>
                ${habitOptions}
              </select>
              <select class="input hgl-id" data-type="${t.key}" data-for="goal" style="display:${linkedType === 'goal' ? '' : 'none'}">
                <option value="">— 选择目标 —</option>
                ${goalOptions}
              </select>
            </div>
          </div>`;
      }).join('');

      showModal('healthGoalModal', `
        <h3 style="font-size:16px;margin-bottom:6px;font-weight:800">🎯 健康目标</h3>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:14px;line-height:1.6">
          · 设为 0 或留空 = 取消该目标<br>
          · <b>绑定到习惯</b>：每天达标后自动打勾习惯<br>
          · <b>绑定到目标</b>：目标必须是量化型，每天数据自动累加为一条记录<br>
          · 只同步今天，不改历史
        </div>
        ${fieldsHtml}
        <div class="modal-actions">
          <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
          <button class="btn btn-sm btn-primary" data-action="health-goal-save" type="button">保存</button>
        </div>
      `, 'lg');

      setTimeout(() => {
        document.querySelectorAll('.hgl-type').forEach(sel => {
          sel.addEventListener('change', () => {
            const block = sel.closest('.health-goal-edit-block');
            if (!block) return;
            const val = sel.value;
            block.querySelectorAll('.hgl-id').forEach(idSel => {
              idSel.style.display = idSel.dataset.for === val ? '' : 'none';
            });
          });
        });
      }, 60);
    },

    'health-goal-save': () => {
      const types = ['water', 'sleep', 'exercise', 'calories'];
      types.forEach(type => {
        const inp = document.querySelector(`.hge-input[data-type="${type}"]`);
        if (!inp) return;
        const unit = inp.dataset.unit;
        const val = parseFloat(inp.value) || 0;

        if (val <= 0) {
          removeGoal(type);
          return;
        }

        const typeSel = document.querySelector(`.hgl-type[data-type="${type}"]`);
        const linkedType = typeSel ? typeSel.value : '';
        let linkedId = '';
        if (linkedType) {
          const idSel = document.querySelector(`.hgl-id[data-type="${type}"][data-for="${linkedType}"]`);
          linkedId = idSel ? idSel.value : '';
          if (!linkedId) {
            setGoal(type, val, unit, null, null);
            return;
          }
        }

        setGoal(type, val, unit, linkedType || null, linkedId || null);
      });

      hideModal();
      toast('已保存目标', 'success');
      rerender();
    }
  }
};

window.addEventListener('theme:changed', () => {
  setTimeout(() => {
    try { drawAllCharts(); } catch (e) { console.warn(e); }
  }, 60);
});