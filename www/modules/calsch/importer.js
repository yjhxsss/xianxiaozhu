import { DB, State, save } from '../../core/db.js';
import { esc, uid, WEEKDAYS, COURSE_COLORS } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';
import { AIHub } from '../diary/ai.js';
import { getSections } from './schedule.js';

/* ============ 内部状态 ============ */
const importState = {
  text: '',
  preview: [],
  source: 'manual'
};

/* ============ 周次重叠检测 ============ */
function parseWeeksSet(expr) {
  const set = new Set();
  if (!expr) return set;
  String(expr).split(/[,，;；]/).forEach(part => {
    part = part.trim();
    const range = part.match(/^(\d+)\s*[-~]\s*(\d+)$/);
    if (range) {
      const s = parseInt(range[1]), e = parseInt(range[2]);
      for (let i = s; i <= e; i++) set.add(i);
    } else {
      const n = parseInt(part);
      if (!isNaN(n)) set.add(n);
    }
  });
  return set;
}

function weeksOverlap(wa, wb) {
  const a = parseWeeksSet(wa);
  const b = parseWeeksSet(wb);
  if (!a.size || !b.size) return true;
  for (const w of a) if (b.has(w)) return true;
  return false;
}

function coursesOverlap(a, b) {
  if (a.dayOfWeek !== b.dayOfWeek) return false;
  if (a.startSection > b.endSection || b.startSection > a.endSection) return false;
  return weeksOverlap(a.weeks, b.weeks);
}

function detectConflicts(list, existing) {
  const conflictPartners = list.map(() => []);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (coursesOverlap(list[i], list[j])) {
        conflictPartners[i].push(list[j].name);
        conflictPartners[j].push(list[i].name);
      }
    }
    for (const e of existing) {
      if (coursesOverlap(list[i], e)) {
        conflictPartners[i].push(`已有:${e.name}`);
      }
    }
  }
  return list.map((item, i) => ({
    ...item,
    conflict: conflictPartners[i].length > 0,
    conflictWith: conflictPartners[i]
  }));
}

/* ============ 纯文本解析器 ============ */
const Parser = {
  timeToMin(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  },

  /* ⭐ 用用户配置的节次时间表；
   *   容差放宽到 40 分钟（用户学校作息差异大时也能匹配）；
   *   优先匹配距离最近的节次
   */
  sectionByTime(start, end) {
    const secs = getSections();
    const sm = this.timeToMin(start), em = this.timeToMin(end);
    let bestS = { d: Infinity, n: null }, bestE = { d: Infinity, n: null };
    for (const sec of secs) {
      const ds = Math.abs(sm - this.timeToMin(sec.start));
      const de = Math.abs(em - this.timeToMin(sec.end));
      if (ds < bestS.d) bestS = { d: ds, n: sec.n };
      if (de < bestE.d) bestE = { d: de, n: sec.n };
    }
    const TOLERANCE = 40;   /* ⭐ 25 → 40 */
    let ss = bestS.d <= TOLERANCE ? bestS.n : null;
    let es = bestE.d <= TOLERANCE ? bestE.n : null;
    if (ss && !es) es = ss;
    if (ss && es && es < ss) es = ss;
    return { start: ss, end: es, distStart: bestS.d, distEnd: bestE.d };
  },

  findDay(text) {
    const m = text.match(/(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/);
    if (!m) return null;
    const map = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':7,'天':7,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7 };
    return map[m[1]] || null;
  },

  findSection(text) {
    let m = text.match(/第?\s*(\d{1,2})\s*[-~到至]\s*(\d{1,2})\s*节/);
    if (m) return { start: parseInt(m[1]), end: parseInt(m[2]) };
    m = text.match(/第?\s*(\d{1,2})\s*节/);
    if (m) { const n = parseInt(m[1]); return { start: n, end: n }; }
    return null;
  },

  findTime(text) {
    const m = text.match(/(\d{1,2}[:：]\d{2})\s*[-~到至]\s*(\d{1,2}[:：]\d{2})/);
    if (!m) return null;
    return { start: m[1].replace('：', ':'), end: m[2].replace('：', ':') };
  },

  findWeeks(text) {
    if (/单周/.test(text)) return '1,3,5,7,9,11,13,15,17,19';
    if (/双周/.test(text)) return '2,4,6,8,10,12,14,16,18,20';
    const ranges = [];
    let m;
    const re = /(\d{1,2})\s*[-~到至]\s*(\d{1,2})\s*周/g;
    while ((m = re.exec(text)) !== null) ranges.push(`${m[1]}-${m[2]}`);
    if (!ranges.length) {
      const sRe = /第?\s*(\d{1,2})\s*周/g;
      const weeks = [];
      while ((m = sRe.exec(text)) !== null) weeks.push(m[1]);
      if (weeks.length) return weeks.join(',');
    }
    return ranges.length ? ranges.join(',') : '1-16';
  },

  findLocation(text) {
    let m = text.match(/\b[A-Z]{1,3}\s*\d{2,4}\b/);
    if (m) return m[0].replace(/\s/g, '');
    m = text.match(/(?:教学楼|实验楼|逸夫楼|图书馆|体育馆|体育场|机房|教[室学]|多媒体)[A-Za-z]?\d{0,4}/);
    return m ? m[0] : '';
  },

  findTeacher(text) {
    const m = text.match(/([\u4e00-\u9fa5]{2,4})\s*(?:老师|教授|讲师)/);
    return m ? m[1] : '';
  },

  parseLine(line) {
    line = line.trim();
    if (line.length < 4) return null;
    const day = this.findDay(line);
    if (!day) return null;

    const section = this.findSection(line);
    const time = this.findTime(line);
    let ss, es;
    if (section) { ss = section.start; es = section.end; }
    else if (time) {
      const s = this.sectionByTime(time.start, time.end);
      if (!s.start) return null;
      ss = s.start; es = s.end || s.start;
    } else return null;

    const weeks = this.findWeeks(line);
    const location = this.findLocation(line);
    const teacher = this.findTeacher(line);

    let name = line;
    name = name.replace(/(?:周|星期|礼拜)\s*[一二三四五六日天1-7]/g, '');
    name = name.replace(/第?\s*\d{1,2}\s*[-~到至,，]\s*\d{0,2}\s*节/g, '');
    name = name.replace(/第?\s*\d{1,2}\s*节/g, '');
    name = name.replace(/\d{1,2}[:：]\d{2}\s*[-~到至]\s*\d{1,2}[:：]\d{2}/g, '');
    name = name.replace(/\d{1,2}\s*[-~到至]\s*\d{1,2}\s*周/g, '');
    name = name.replace(/第?\s*\d{1,2}\s*周/g, '');
    name = name.replace(/单周|双周/g, '');
    if (location) name = name.replace(location, '');
    if (teacher) name = name.replace(new RegExp(teacher + '\\s*(?:老师|教授|讲师)?'), '');
    name = name.replace(/[,，:：\-–—\s\u3000]+/g, ' ').trim();
    name = name.replace(/^[,，。、\s\-]+|[,，。、\s\-]+$/g, '');
    if (!name) name = '未命名课程';

    return { name, teacher, location, dayOfWeek: day, startSection: ss, endSection: es, weeks };
  },

  parse(text) {
    return text.split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 2)
      .map(l => this.parseLine(l))
      .filter(Boolean);
  }
};

/* ============ CSV 解析器 ============ */
const CsvParser = {
  detectHeader(row) {
    const map = {};
    row.forEach((cell, i) => {
      const s = String(cell).trim().toLowerCase();
      if (/课程|名称|科目|name/.test(s)) map.name = i;
      else if (/星期|周几|day/.test(s)) map.dayOfWeek = i;
      else if (/节次|节数|节|section/.test(s)) map.section = i;
      else if (/开始|起始|起/.test(s)) map.startSection = i;
      else if (/结束|终止|止/.test(s)) map.endSection = i;
      else if (/周次|周数|weeks?/.test(s)) map.weeks = i;
      else if (/地点|教室|location|room/.test(s)) map.location = i;
      else if (/老师|教师|teacher/.test(s)) map.teacher = i;
      else if (/时间|time/.test(s)) map.time = i;
    });
    return map;
  },
  splitLine(line) {
    if (line.includes('\t')) return line.split('\t');
    if (line.includes(',')) return line.split(',').map(s => s.replace(/^"|"$/g, '').trim());
    if (/[；;]/.test(line)) return line.split(/[；;]/).map(s => s.trim());
    return line.split(/\s{2,}/);
  },
  parseDay(s) {
    const m = String(s).match(/(?:周|星期|礼拜)?\s*([一二三四五六日天1-7])/);
    if (!m) return null;
    const map = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':7,'天':7,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7 };
    return map[m[1]] || null;
  },
  parse(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;

    const rows = lines.map(l => this.splitLine(l));
    const header = this.detectHeader(rows[0]);
    const keyCount = ['name','dayOfWeek','section','startSection'].filter(k => header[k] != null).length;
    if (keyCount < 2) return null;

    const courses = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row.length) continue;
      const name = header.name != null ? String(row[header.name] || '').trim() : '';
      if (!name) continue;

      const dayText = header.dayOfWeek != null ? String(row[header.dayOfWeek] || '') : '';
      const dayOfWeek = this.parseDay(dayText);
      if (!dayOfWeek) continue;

      let startSection = null, endSection = null;
      if (header.section != null) {
        const s = String(row[header.section] || '');
        const m = s.match(/(\d{1,2})\s*[-~到至]\s*(\d{1,2})/);
        if (m) { startSection = parseInt(m[1]); endSection = parseInt(m[2]); }
        else { const n = parseInt(s); if (n) { startSection = endSection = n; } }
      }
      if (!startSection && header.startSection != null) {
        startSection = parseInt(row[header.startSection]) || null;
        endSection = header.endSection != null ? parseInt(row[header.endSection]) : startSection;
      }
      if (!startSection) continue;

      courses.push({
        name,
        dayOfWeek,
        startSection,
        endSection: endSection || startSection,
        weeks: header.weeks != null ? (String(row[header.weeks] || '').trim() || '1-16') : '1-16',
        location: header.location != null ? String(row[header.location] || '').trim() : '',
        teacher: header.teacher != null ? String(row[header.teacher] || '').trim() : ''
      });
    }
    return courses.length ? courses : null;
  }
};

/* ============ 智能解析 ============ */
function smartParse(text) {
  const csvResult = CsvParser.parse(text);
  if (csvResult && csvResult.length) return { list: csvResult, source: 'csv' };

  const txtResult = Parser.parse(text);
  if (txtResult && txtResult.length) return { list: txtResult, source: 'manual' };

  return { list: [], source: 'manual' };
}

/* ============ AI 审查 ============ */
async function runAIReview(text) {
  if (!AIHub.isEnabled()) throw new Error('AI 未启用，请到设置开启');

  /* ⭐ 动态生成节次对照表：用用户实际作息 */
  const secTable = getSections()
    .map(s => `${s.n}=${s.start}-${s.end}`)
    .join(', ');

  const prompt = `请把下面的课表文本解析成 JSON 数组。

【课表文本】
"""
${text}
"""

【输出格式】严格返回 JSON 数组，不要任何其他文字或 markdown 标记：
[
  {
    "name": "课程名",
    "dayOfWeek": 1,
    "startSection": 1,
    "endSection": 2,
    "weeks": "1-16",
    "location": "地点",
    "teacher": "老师"
  }
]

【要求】
1. dayOfWeek：周一=1，周日=7
2. **节次对照表（用户学校实际作息，如果给的是时间，选最接近的节次）**：
   ${secTable}
3. 同一门课如果有多个时间段（比如周一1-2节和周三3-4节），拆成多条记录
4. weeks 缺省填 "1-16"；单周填 "1,3,5,7,9,11,13,15,17,19"；双周填 "2,4,6,8,10,12,14,16,18,20"
5. location 和 teacher 没有就填空字符串 ""
6. 忽略表头行、空行、"合计"、"备注"之类无关内容
7. **⭐ 映射不确定时的处理**：
   - 如果原文给的是具体时间（如 "08:00-09:40"），而按对照表能找到差距在 20 分钟内的节次 → 直接填 startSection / endSection
   - 如果原文时间和对照表**所有节次都相差超过 20 分钟**（用户学校作息可能和对照表不一致），则：
     * startSection 和 endSection 填 null
     * 额外加两个字段 rawStartTime / rawEndTime，值为原文的时间字符串（格式 "HH:MM"）
     * 例：{"name":"高等数学","dayOfWeek":1,"startSection":null,"endSection":null,"rawStartTime":"08:00","rawEndTime":"09:40","weeks":"1-16","location":"","teacher":""}
   - 如果原文给的是节次（如 "1-2节"），直接填数字，不需要 rawStartTime/rawEndTime
8. 只输出 JSON 数组，不要任何解释`;

  const content = await AIHub.chat([
    { role: 'system', content: '你是一个课表解析助手，只输出严格合法的 JSON 数组。' },
    { role: 'user', content: prompt }
  ], { temperature: 0.2, maxTokens: 1800 });

  let s = String(content).replace(/```json|```/g, '').trim();
  let arr;
  try { arr = JSON.parse(s); }
  catch {
    const m = s.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('AI 返回格式错误');
    arr = JSON.parse(m[0]);
  }
  if (!Array.isArray(arr)) throw new Error('AI 返回格式错误');

  const maxSection = Math.max(10, getSections().length);

  return arr
    .filter(x => x && x.name)
    .map(x => {
      let ss = parseInt(x.startSection) || null;
      let es = parseInt(x.endSection) || null;

      /* ⭐ AI 映射不出来但保留了原始时间 → 本地二次映射 */
      if (!ss && x.rawStartTime && /^\d{1,2}:\d{2}$/.test(String(x.rawStartTime))) {
        const rawEnd = String(x.rawEndTime || x.rawStartTime);
        const r = Parser.sectionByTime(String(x.rawStartTime), rawEnd);
        if (r.start) {
          ss = r.start;
          es = r.end || r.start;
        }
      }

      /* ⭐ 都没映射出来：兜底填 1-2 节，用户导入后会看到并在预览里核对 */
      if (!ss) {
        ss = 1;
        es = es || 2;
      }

      return {
        name: String(x.name).slice(0, 40),
        dayOfWeek: Math.max(1, Math.min(7, parseInt(x.dayOfWeek) || 1)),
        startSection: Math.max(1, Math.min(maxSection, ss)),
        endSection: Math.max(1, Math.min(maxSection, es || ss)),
        weeks: String(x.weeks || '1-16').slice(0, 60),
        location: String(x.location || '').slice(0, 30),
        teacher: String(x.teacher || '').slice(0, 20)
      };
    });
}

/* ============ 渲染 ============ */
function renderImportModal() {
  return `
    <h3 style="font-size:16px;margin-bottom:10px;font-weight:800">📄 一键导入课表</h3>
    <div class="hint-box" style="margin-bottom:12px">
      <b>支持：</b>纯文本、CSV 表格、拖放 .txt/.csv 文件<br>
      <b>PDF/Excel：</b>请先在编辑器里打开，<b>全选复制文字</b>，粘贴到下面。<br>
      <b>格式乱？</b>点「🤖 AI 审查」，AI 会重新整理（消耗少量 token）。<br>
      <b>作息不一致？</b>先去 ⚙️ 设置你的真实作息，AI 和文本解析都会按它匹配。
    </div>
    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <button class="btn btn-sm" data-action="course-load-file" type="button">📁 选择文件</button>
      <input type="file" id="courseImportFile" accept=".txt,.csv,.text" style="display:none">
      <button class="btn btn-sm" data-action="course-load-sample" type="button">📋 载入示例</button>
      <button class="btn btn-sm" data-action="course-load-csv-sample" type="button">📊 CSV 示例</button>
      <button class="btn btn-sm" data-action="course-clear-text" type="button">🗑️ 清空</button>
    </div>
    <div id="courseDropZone" class="course-drop-zone">
      <textarea class="input" id="courseImportText" style="min-height:150px;font-family:var(--mono);font-size:12px;line-height:1.6;border:none;background:transparent" placeholder="在此粘贴课表文本，或把 .txt/.csv 文件拖到这里...">${esc(importState.text)}</textarea>
    </div>
    <div id="courseImportPreview" style="margin-top:14px"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap">
      <button class="btn btn-sm" data-action="modal-close" type="button">关闭</button>
      <button class="btn btn-sm" data-action="course-ai-review" type="button">🤖 AI 审查</button>
      <button class="btn btn-sm btn-primary" data-action="course-parse" type="button">🔍 解析预览</button>
    </div>
  `;
}

function renderPreview() {
  const el = document.getElementById('courseImportPreview');
  if (!el) return;
  if (!importState.preview.length) {
    el.innerHTML = '<div class="done-empty">未解析到课程，检查格式</div>';
    return;
  }
  const selected = importState.preview.filter(x => x.selected).length;
  const conflicts = importState.preview.filter(x => x.conflict).length;

  const srcTag = importState.source === 'ai'
    ? '<span style="color:var(--accent);font-weight:800">🤖 AI 审查结果</span>'
    : (importState.source === 'csv'
      ? '<span style="color:var(--info);font-weight:800">📊 CSV 解析</span>'
      : '<span style="color:var(--text-muted);font-weight:800">📄 文本解析</span>');

  el.innerHTML = `
    <div style="font-size:13px;font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span>解析结果</span>
      ${srcTag}
      <span style="color:var(--text-muted);font-weight:600">已选 ${selected}/${importState.preview.length}</span>
      ${conflicts ? `<span style="color:var(--warning);font-weight:800">⚠️ 检测到 ${conflicts} 门与现有课程冲突</span>` : ''}
    </div>
    ${conflicts ? `
      <div class="hint-box" style="background:rgba(251,191,36,.08);border-left-color:var(--warning);margin-bottom:10px">
        ⚠️ 冲突的课程会以黄框显示。你仍然可以导入，导入后周课表会把冲突课程<b>并排显示</b>。
      </div>
    ` : ''}
    <div class="course-import-preview">
      ${importState.preview.map((p, i) => `
        <div class="ci-item ${p.selected ? 'selected' : ''}${p.conflict ? ' conflict' : ''}" data-action="course-toggle-preview" data-idx="${i}">
          <div class="ci-check">${p.selected ? '✓' : ''}</div>
          <div class="ci-info">
            <div class="ci-name">${esc(p.name)}</div>
            <div class="ci-meta">
              周${WEEKDAYS[p.dayOfWeek - 1]} · 第${p.startSection}-${p.endSection}节
              ${p.location ? ' · 📍' + esc(p.location) : ''}
              ${p.teacher ? ' · 👤' + esc(p.teacher) : ''}
              ${p.weeks ? ' · 📅' + esc(p.weeks) : ''}
            </div>
          </div>
          ${p.conflict ? `<span class="ci-conflict-tag" title="${esc((p.conflictWith || []).join('、'))}">⚠️ 冲突</span>` : ''}
        </div>
      `).join('')}
    </div>
    <div style="display:flex;gap:8px;justify-content:space-between;margin-top:12px;align-items:center">
      <button class="btn btn-sm" data-action="course-preview-selectall" type="button">全选/全不选</button>
      <button class="btn btn-sm btn-primary" data-action="course-import-confirm" type="button">✅ 导入 ${selected} 门课程</button>
    </div>
  `;
}

function applyColorAndSelect(list) {
  const base = DB.courses.filter(c => c.user_id === State.user.id).length;
  return list.map((p, i) => ({
    ...p,
    color: COURSE_COLORS[(base + i) % COURSE_COLORS.length],
    selected: true
  }));
}

function markConflicts(list) {
  const existing = DB.courses.filter(c => c.user_id === State.user.id);
  return detectConflicts(list, existing);
}

/* ============ 文件读取 + 拖放 ============ */
function readFileInto(file, ta) {
  const ext = (file.name.toLowerCase().split('.').pop() || '');
  if (!['txt', 'csv', 'text'].includes(ext)) {
    toast('只支持 .txt 和 .csv（PDF/Excel 请复制文字粘贴）', 'warning');
    return;
  }
  const reader = new FileReader();
  reader.onload = ev => {
    ta.value = ev.target.result;
    importState.text = ta.value;
    importState.source = ext === 'csv' ? 'csv' : 'manual';
    toast(`已载入 ${file.name}`, 'success');
  };
  reader.readAsText(file, 'UTF-8');
}

function bindDropZone() {
  const zone = document.getElementById('courseDropZone');
  if (!zone) return;
  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const ta = document.getElementById('courseImportText');
    if (ta) readFileInto(f, ta);
  });
}

function bindFileInput() {
  const fi = document.getElementById('courseImportFile');
  if (!fi) return;
  fi.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const ta = document.getElementById('courseImportText');
    if (ta) readFileInto(f, ta);
    fi.value = '';
  });
}

/* ============ Actions ============ */
export const actions = {
  'course-import': () => {
    importState.text = '';
    importState.preview = [];
    importState.source = 'manual';
    showModal('courseImport', renderImportModal(), 'lg');
    setTimeout(() => {
      bindFileInput();
      bindDropZone();
    }, 60);
  },

  'course-load-file': () => {
    const fi = document.getElementById('courseImportFile');
    if (fi) fi.click();
  },

  'course-load-sample': () => {
    const sample = [
      '高等数学 周一 1-2节 A101 张老师',
      '大学英语 星期一 第3-4节 教学楼B203',
      '数据结构 周二 08:00-09:40 A301 王教授',
      '体育 周五 5-6节 体育馆',
      '线性代数 周三 3-4节 逸夫楼302 单周'
    ].join('\n');
    importState.text = sample;
    importState.source = 'manual';
    const ta = document.getElementById('courseImportText');
    if (ta) ta.value = sample;
    toast('已载入纯文本示例', 'success');
  },

  'course-load-csv-sample': () => {
    const sample = [
      '课程名称,星期,节次,周次,地点,老师',
      '高等数学,周一,1-2,1-16,A101,张老师',
      '大学英语,周一,3-4,1-16,教学楼B203,李老师',
      '数据结构,周二,1-2,1-16,A301,王教授',
      '体育,周五,5-6,1-16,体育馆,赵老师',
      '线性代数,周三,3-4,1-8单周,逸夫楼302,刘老师'
    ].join('\n');
    importState.text = sample;
    importState.source = 'csv';
    const ta = document.getElementById('courseImportText');
    if (ta) ta.value = sample;
    toast('已载入 CSV 示例，点「解析预览」', 'success');
  },

  'course-clear-text': () => {
    importState.text = '';
    importState.preview = [];
    importState.source = 'manual';
    const ta = document.getElementById('courseImportText');
    if (ta) ta.value = '';
    const el = document.getElementById('courseImportPreview');
    if (el) el.innerHTML = '';
  },

  'course-parse': () => {
    const ta = document.getElementById('courseImportText');
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) { toast('请先输入课表文本', 'warning'); return; }

    importState.text = text;
    const result = smartParse(text);

    if (!result.list.length) {
      toast('本地解析失败，试试「AI 审查」', 'warning');
      importState.preview = [];
      renderPreview();
      return;
    }

    importState.source = result.source;
    const withConflicts = markConflicts(result.list);
    importState.preview = applyColorAndSelect(withConflicts);
    renderPreview();

    const conflictCount = withConflicts.filter(x => x.conflict).length;
    const srcLabel = result.source === 'csv' ? 'CSV' : '文本';
    if (conflictCount) {
      toast(`解析 ${result.list.length} 门（${srcLabel}），⚠️ ${conflictCount} 门冲突`, 'warning');
    } else {
      toast(`解析成功 ${result.list.length} 门（${srcLabel}）`, 'success');
    }
  },

  'course-ai-review': async () => {
    const ta = document.getElementById('courseImportText');
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) { toast('请先输入课表文本', 'warning'); return; }

    if (!AIHub.isEnabled()) {
      toast('请先到设置启用 AI', 'warning');
      return;
    }

    const el = document.getElementById('courseImportPreview');
    if (el) {
      el.innerHTML = `
        <div style="padding:30px;text-align:center;color:var(--text-muted)">
          <div style="font-size:32px;margin-bottom:8px">🤖</div>
          <div style="font-size:13px;font-weight:600">AI 审查中，请稍候…</div>
          <div style="font-size:11.5px;margin-top:6px">通常 3-10 秒</div>
        </div>`;
    }

    try {
      const list = await runAIReview(text);
      if (!list.length) throw new Error('AI 未解析出任何课程');

      importState.text = text;
      importState.source = 'ai';
      const withConflicts = markConflicts(list);
      importState.preview = applyColorAndSelect(withConflicts);
      renderPreview();

      const conflictCount = withConflicts.filter(x => x.conflict).length;
      if (conflictCount) {
        toast(`AI 审查完成，共 ${list.length} 门，⚠️ ${conflictCount} 门冲突`, 'warning');
      } else {
        toast(`AI 审查完成，共 ${list.length} 门`, 'success');
      }
    } catch (e) {
      console.error('[AI review]', e);
      toast('AI 审查失败：' + e.message, 'error');
      if (importState.preview.length) renderPreview();
      else if (el) el.innerHTML = '';
    }
  },

  'course-toggle-preview': (el) => {
    const idx = parseInt(el.dataset.idx);
    if (isNaN(idx) || !importState.preview[idx]) return;
    importState.preview[idx].selected = !importState.preview[idx].selected;
    renderPreview();
  },

  'course-preview-selectall': () => {
    const allSelected = importState.preview.every(x => x.selected);
    importState.preview.forEach(x => { x.selected = !allSelected; });
    renderPreview();
  },

  'course-import-confirm': () => {
    const selected = importState.preview.filter(x => x.selected);
    if (!selected.length) { toast('请至少选择一门课程', 'warning'); return; }

    selected.forEach(p => {
      DB.courses.push({
        id: uid(),
        user_id: State.user.id,
        name: p.name,
        teacher: p.teacher || '',
        location: p.location || '',
        dayOfWeek: p.dayOfWeek,
        startSection: p.startSection,
        endSection: p.endSection,
        weeks: p.weeks || '1-16',
        color: p.color,
        createdAt: new Date().toISOString()
      });
    });
    save('courses');
    emit('db:changed');
    hideModal();
    importState.preview = [];
    importState.text = '';
    importState.source = 'manual';
    toast(`已导入 ${selected.length} 门课程`, 'success');
    rerender();
  }
};