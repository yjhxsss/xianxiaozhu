export const $ = (s, e = document) => e.querySelector(s);
export const $$ = (s, e = document) => Array.from(e.querySelectorAll(s));

export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[m]));

export const pad = n => String(n).padStart(2, '0');

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const fmtD = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
};

export const uid = () => Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const localTime = iso => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

export const diffDays = (a, b) => Math.floor((new Date(a) - new Date(b)) / 86400000);

export const weekStart = d => {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
};

export const calcBMI = (w, h) => (w > 0 && h > 0) ? parseFloat((w / Math.pow(h / 100, 2)).toFixed(2)) : null;

// 全局 id 计数器（用于动画 key）
export const isRainy = c => [51,53,55,61,63,65,80,81,82,95,96,99].includes(c);
export const isSnowy = c => [71,73,75,77,85,86].includes(c);

// 用于表情
export const MOOD_EMOJIS = ['😄','🙂','😐','😔','😡'];
export const MOOD_SCORE = { '😄': 5, '🙂': 4, '😐': 3, '😔': 2, '😡': 1 };
export const SCORE_EMOJIS = ['😡','😔','😐','🙂','😄'];
export const MOOD_TAGS = ['工作','学习','人际','天气','健康','家庭','兴趣'];
export const FOCUS_TAGS = ['学习','工作','阅读','写作','编程','运动'];
export const WEEKDAYS = ['一','二','三','四','五','六','日'];
export const COURSE_COLORS = ['#7c6cf8','#4ade80','#fbbf24','#f87171','#60a5fa','#f472b6','#34d399','#fb923c','#a78bfa','#22d3ee'];
export const SECTIONS = [
  { n:1, start:'08:00', end:'08:45' }, { n:2, start:'08:55', end:'09:40' },
  { n:3, start:'10:00', end:'10:45' }, { n:4, start:'10:55', end:'11:40' },
  { n:5, start:'14:00', end:'14:45' }, { n:6, start:'14:55', end:'15:40' },
  { n:7, start:'16:00', end:'16:45' }, { n:8, start:'16:55', end:'17:40' },
  { n:9, start:'19:00', end:'19:45' }, { n:10, start:'19:55', end:'20:40' }
];

export const WMO = {
  0:{icon:'☀️',desc:'晴天'}, 1:{icon:'🌤️',desc:'晴间多云'}, 2:{icon:'⛅',desc:'多云'}, 3:{icon:'☁️',desc:'阴天'},
  45:{icon:'🌫️',desc:'雾'}, 51:{icon:'🌦️',desc:'小毛毛雨'}, 61:{icon:'🌧️',desc:'小雨'}, 63:{icon:'🌧️',desc:'中雨'},
  65:{icon:'🌧️',desc:'大雨'}, 71:{icon:'🌨️',desc:'小雪'}, 73:{icon:'❄️',desc:'中雪'}, 75:{icon:'❄️',desc:'大雪'},
  80:{icon:'🌦️',desc:'阵雨'}, 81:{icon:'🌧️',desc:'阵雨'}, 82:{icon:'⛈️',desc:'强阵雨'}, 95:{icon:'⛈️',desc:'雷暴'},
  96:{icon:'⛈️',desc:'雷暴伴冰雹'}, 99:{icon:'⛈️',desc:'强雷暴'}
};

export const WEATHER_TXT_TO_WMO = (() => {
  const m = [['晴',0],['多云',2],['少云',2],['阴',3],['雾',45],['霾',45],['浮尘',45],['扬沙',45],['沙尘',45],
    ['雷阵雨',95],['雷暴',95],['冰雹',96],['暴雨',65],['大雨',65],['中雨',63],['小雨',61],['雨夹雪',80],['阵雨',80],
    ['大雪',75],['中雪',73],['小雪',71],['雪',71]];
  return (txt) => {
    const s = String(txt || '').trim();
    for (const [k, v] of m) if (s.includes(k)) return v;
    return 3;
  };
})();