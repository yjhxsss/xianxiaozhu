import { DB, State, save } from '../../core/db.js';
import { uid } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';
import { AIHub } from '../diary/ai.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

/* ============ 本地解析 ============ */
export function parseLocal(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l);
  const cards = [];
  let failed = 0;

  lines.forEach(line => {
    let parts;
    if (line.includes('---')) {
      parts = line.split('---').map(s => s.trim());
    } else if (line.includes('\t')) {
      parts = line.split('\t').map(s => s.trim());
    } else if (line.includes(',') && line.split(',').length >= 2) {
      parts = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    } else if (line.includes('｜') || line.includes('|')) {
      parts = line.split(/[｜|]/).map(s => s.trim());
    } else {
      failed++;
      return;
    }
    if (parts.length < 2 || !parts[0] || !parts[1]) { failed++; return; }
    cards.push({
      id: uid(),
      front: parts[0].slice(0, 200),
      back: parts[1].slice(0, 500),
      example: parts[2] ? parts[2].slice(0, 300) : '',
      selected: true
    });
  });

  return { cards, failed };
}

/* ============ ⭐ 去重检测 ============ */
function normalizeFront(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 检查待导入卡片和已有卡片组的重复情况
 * @returns {{
 *   newCards: Array,       // 全新卡片
 *   dupCards: Array,       // 重复卡片（含 existingId）
 *   existingMap: Map       // 规范化 front → existing card
 * }}
 */
function checkDuplicates(cards, deckId) {
  const existing = DB.cards.filter(c => c.user_id === State.user.id && c.deck_id === deckId);
  const map = new Map();
  existing.forEach(c => { map.set(normalizeFront(c.front), c); });

  const newCards = [];
  const dupCards = [];
  const seenInBatch = new Set();

  cards.forEach(c => {
    const key = normalizeFront(c.front);
    if (!key) { newCards.push(c); return; }
    /* 批内自重复（同一批里 front 相同） */
    if (seenInBatch.has(key)) {
      dupCards.push({ ...c, _dupType: 'batch' });
      return;
    }
    seenInBatch.add(key);

    const ex = map.get(key);
    if (ex) {
      dupCards.push({ ...c, _dupType: 'existing', _existingId: ex.id, _existing: ex });
    } else {
      newCards.push(c);
    }
  });

  return { newCards, dupCards, existingMap: map };
}

/* ============ AI 生成 ============ */
export async function aiReviewText(text, deckName) {
  if (!AIHub.isEnabled()) throw new Error('AI 未启用');

  const prompt = `请把下面的学习材料整理成学习卡片（正反面）。

【材料来源】${deckName || '未知'}
【原始文本】
"""
${text.slice(0, 4000)}
"""

【要求】
1. 严格返回 JSON 数组，不要任何 markdown 标记
2. 每张卡片：
   - front：正面 / 问题（简短，10-30 字）
   - back：背面 / 答案（清晰，说明要点）
   - example：例句或补充说明（可选，可空）
3. 从材料中**提取**知识点，不要编造不存在的内容
4. 如果材料本身已经是"问题 → 答案"格式，直接结构化即可
5. 内容太少就少生成，不要硬凑

【输出格式】
[
  {"front":"abandon","back":"v. 放弃；抛弃","example":"He abandoned the plan."}
]`;

  const text2 = await AIHub.chat([
    { role: 'system', content: '你是一个学习卡片整理助手，只输出严格 JSON 数组。' },
    { role: 'user', content: prompt }
  ], { temperature: 0.4, maxTokens: 3000 });

  let s = String(text2).replace(/```json|```/g, '').trim();
  let arr;
  try { arr = JSON.parse(s); }
  catch {
    const m = s.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('AI 返回格式错误');
    arr = JSON.parse(m[0]);
  }
  if (!Array.isArray(arr)) throw new Error('AI 返回格式错误');

  return arr
    .filter(x => x && x.front && x.back)
    .map(x => ({
      id: uid(),
      front: String(x.front).trim().slice(0, 200),
      back: String(x.back).trim().slice(0, 500),
      example: String(x.example || '').trim().slice(0, 300),
      selected: true
    }));
}

/* ============ 导入弹窗 ============ */
export function showImportDialog(deckId) {
  const decks = DB.decks.filter(d => d.user_id === State.user.id);
  const presetDeckId = deckId || State.reviewDeckId || '';
  const deckOptions = decks.map(d =>
    `<option value="${d.id}"${presetDeckId === d.id ? ' selected' : ''}>${d.name}</option>`
  ).join('');

  showModal('cardImport', `
    <h3 style="font-size:16px;margin-bottom:10px;font-weight:800">📥 导入卡片</h3>
    <div class="hint-box" style="margin-bottom:14px">
      <b>支持格式：</b>CSV / TXT / 自由文本<br>
      每行一张卡片，用 <code>---</code> 或 <code>Tab</code> 或 <code>逗号</code> 分隔：<br>
      <code>abandon --- v. 放弃；抛弃 --- He abandoned the plan.</code><br>
      <code>benefit, n. 利益；好处</code><br>
      第三段（例句）可选。空行忽略。
    </div>

    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px;font-weight:600">目标卡片组</label>
      <select class="input" id="importDeck">
        <option value="__new__">+ 新建卡片组</option>
        ${deckOptions}
      </select>
    </div>

    <div id="importNewDeckRow" class="${presetDeckId ? 'hidden' : ''}" style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px;font-weight:600">新卡片组名称</label>
      <input type="text" class="input" id="importNewDeckName" placeholder="如：英语四级词汇">
    </div>

    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <button class="btn btn-sm" data-action="import-load-file" type="button">📁 选择文件</button>
      <input type="file" id="importFileInput" accept=".csv,.txt,.text,.md" style="display:none">
      <button class="btn btn-sm" data-action="import-load-sample" type="button">📋 载入示例</button>
      <button class="btn btn-sm" data-action="import-clear" type="button">🗑️ 清空</button>
      <button class="btn btn-sm btn-primary" data-action="import-ai-review" type="button" title="让 AI 整理成规范卡片">🤖 AI 审查</button>
    </div>

    <div id="importDropZone" class="review-drop-zone">
      <textarea class="input" id="importText" style="min-height:200px;font-family:var(--mono);font-size:12px;line-height:1.7;border:none;background:transparent;width:100%" placeholder="在此粘贴内容，或把 .csv / .txt 文件拖到这里..."></textarea>
    </div>

    <div id="importPreview" style="margin-top:14px"></div>

    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
      <button class="btn btn-sm btn-primary" data-action="import-confirm" type="button">✓ 导入</button>
    </div>
  `, 'lg');

  setTimeout(() => {
    const sel = document.getElementById('importDeck');
    const row = document.getElementById('importNewDeckRow');
    if (sel && row) {
      const toggle = () => row.classList.toggle('hidden', sel.value !== '__new__');
      sel.addEventListener('change', toggle);
      toggle();
    }

    const fi = document.getElementById('importFileInput');
    if (fi) fi.addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) readFileInto(f);
      fi.value = '';
    });

    const zone = document.getElementById('importDropZone');
    if (zone) {
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
      zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('dragover');
        const f = e.dataTransfer.files[0];
        if (f) readFileInto(f);
      });
    }
  }, 60);
}

function readFileInto(file) {
  const ext = (file.name.toLowerCase().split('.').pop() || '');
  if (!['csv', 'txt', 'text', 'md'].includes(ext)) {
    toast('只支持 .csv / .txt / .md', 'warning');
    return;
  }
  const reader = new FileReader();
  reader.onload = ev => {
    const ta = document.getElementById('importText');
    if (ta) {
      ta.value = ev.target.result;
      renderImportPreview();
    }
    toast(`已载入 ${file.name}`, 'success');
  };
  reader.readAsText(file, 'UTF-8');
}

export function renderImportPreview() {
  const el = document.getElementById('importPreview');
  if (!el) return;
  const ta = document.getElementById('importText');
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) { el.innerHTML = ''; return; }

  const { cards, failed } = parseLocal(text);
  if (!cards.length) {
    el.innerHTML = `<div style="padding:12px;font-size:12px;color:var(--text-muted);text-align:center">
      未识别到卡片。每行需要正反面（用 --- 或 Tab 或逗号分隔）<br>
      也可以点「🤖 AI 审查」让 AI 帮忙整理
    </div>`;
    return;
  }

  const preview = cards.slice(0, 5);
  el.innerHTML = `
    <div style="font-size:12.5px;font-weight:700;margin-bottom:8px">
      📋 本地解析：${cards.length} 张${failed ? `（${failed} 行格式错误）` : ''}
    </div>
    <div class="import-preview-list">
      ${preview.map(c => `
        <div class="import-preview-item">
          <div class="ipi-front">${esc(c.front)}</div>
          <div class="ipi-back">${esc(c.back)}</div>
          ${c.example ? `<div class="ipi-example">${esc(c.example)}</div>` : ''}
        </div>
      `).join('')}
      ${cards.length > 5 ? `<div style="font-size:11.5px;color:var(--text-muted);text-align:center;padding:6px">...还有 ${cards.length - 5} 张</div>` : ''}
    </div>
  `;
}

export function renderAIReviewed(cards, deckName) {
  const el = document.getElementById('importPreview');
  if (!el) return;
  if (!cards.length) {
    el.innerHTML = `<div style="padding:12px;font-size:12px;color:var(--text-muted);text-align:center">AI 未返回有效卡片</div>`;
    return;
  }
  el.innerHTML = `
    <div style="font-size:12.5px;font-weight:700;margin-bottom:8px;color:var(--accent)">
      🤖 AI 审查完成：${cards.length} 张
    </div>
    <div class="import-preview-list">
      ${cards.slice(0, 8).map(c => `
        <div class="import-preview-item reviewed">
          <div class="ipi-front">${esc(c.front)}</div>
          <div class="ipi-back">${esc(c.back)}</div>
          ${c.example ? `<div class="ipi-example">${esc(c.example)}</div>` : ''}
        </div>
      `).join('')}
      ${cards.length > 8 ? `<div style="font-size:11.5px;color:var(--text-muted);text-align:center;padding:6px">...还有 ${cards.length - 8} 张</div>` : ''}
    </div>
  `;
}

/* ============ ⭐ 去重确认弹窗 ============ */
function showDedupeDialog({ deckId, deckName, newCards, dupCards, source, onDone }) {
  const batchDups = dupCards.filter(c => c._dupType === 'batch');
  const existingDups = dupCards.filter(c => c._dupType === 'existing');

  showModal('dedupeDialog', `
    <h3 style="font-size:16px;margin-bottom:12px;font-weight:800">⚠️ 检测到重复卡片</h3>
    <div style="font-size:13px;color:var(--text-sec);line-height:1.8;margin-bottom:16px">
      目标卡片组：<b style="color:var(--text)">${esc(deckName)}</b><br>
      <span style="color:var(--success)">🆕 全新卡片：<b>${newCards.length}</b> 张</span><br>
      <span style="color:var(--warning)">🔄 与卡片组已有内容重复：<b>${existingDups.length}</b> 张</span><br>
      ${batchDups.length ? `<span style="color:var(--info)">📑 本批导入内部重复：<b>${batchDups.length}</b> 张</span><br>` : ''}
    </div>

    <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:16px">
      <div style="font-size:11.5px;font-weight:800;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase">重复示例（前 5 条）</div>
      ${existingDups.slice(0, 5).map(c => `
        <div style="font-size:12px;padding:6px 0;border-bottom:1px dashed var(--border)">
          <b>${esc(c.front)}</b>
          <span style="color:var(--text-muted);margin-left:8px">→ 卡片组里已有</span>
        </div>
      `).join('')}
      ${existingDups.length > 5 ? `<div style="font-size:11px;color:var(--text-muted);text-align:center;padding-top:6px">...还有 ${existingDups.length - 5} 条</div>` : ''}
    </div>

    <div style="font-size:12.5px;color:var(--text-sec);line-height:1.8;margin-bottom:16px">
      <b>选择处理方式：</b><br>
      · <b>跳过重复</b>：只导入 ${newCards.length} 张全新卡片（推荐）<br>
      · <b>覆盖已有</b>：重复的卡片用新内容替换（保留原有复习进度）<br>
      · <b>全部导入</b>：可能造成卡片组里出现重复项
    </div>

    <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
      <button class="btn btn-sm" data-action="dedupe-cancel" type="button">取消</button>
      <button class="btn btn-sm btn-ghost" data-action="dedupe-import-all" type="button">全部导入</button>
      <button class="btn btn-sm" data-action="dedupe-overwrite" type="button">覆盖已有</button>
      <button class="btn btn-sm btn-primary" data-action="dedupe-skip" type="button">跳过重复（${newCards.length}）</button>
    </div>
  `, 'lg');

  /* 缓存上下文 */
  State._dedupeCtx = { deckId, deckName, newCards, dupCards, source, onDone };
}

/* ============ 执行导入 ============ */
function doImport(strategy) {
  const ctx = State._dedupeCtx;
  if (!ctx) return;
  const { deckId, newCards, dupCards } = ctx;

  let inserted = 0;
  let overwritten = 0;
  let skipped = 0;

  /* 1. 全新卡片 → 全插 */
  if (strategy !== 'overwrite') {
    newCards.forEach(c => {
      DB.cards.push(buildCard(c, deckId));
      inserted++;
    });
  } else {
    /* 覆盖模式也把全新的插进去 */
    newCards.forEach(c => {
      DB.cards.push(buildCard(c, deckId));
      inserted++;
    });
  }

  /* 2. 重复卡片处理 */
  if (strategy === 'skip') {
    skipped = dupCards.length;
  } else if (strategy === 'overwrite') {
    dupCards.forEach(c => {
      if (c._dupType === 'existing' && c._existing) {
        const ex = DB.cards.find(x => x.id === c._existing.id);
        if (ex) {
          ex.back = c.back;
          if (c.example) ex.example = c.example;
          overwritten++;
        }
      } else {
        /* 批内重复：直接插 */
        DB.cards.push(buildCard(c, deckId));
        inserted++;
      }
    });
  } else if (strategy === 'all') {
    dupCards.forEach(c => {
      /* 批内重复用新 id 插 */
      const copy = { ...c };
      delete copy._existingId;
      delete copy._existing;
      delete copy._dupType;
      DB.cards.push(buildCard(copy, deckId));
      inserted++;
    });
  }

  save('cards');
  emit('db:changed');
  hideModal();
  State._dedupeCtx = null;
  State._aiReviewedCards = null;

  const parts = [];
  if (inserted) parts.push(`新增 ${inserted} 张`);
  if (overwritten) parts.push(`覆盖 ${overwritten} 张`);
  if (skipped) parts.push(`跳过 ${skipped} 张`);
  toast(`✅ ${parts.join(' · ')}`, 'success');
  rerender();

  if (ctx.onDone) ctx.onDone();
}

function buildCard(c, deckId) {
  return {
    id: uid(),
    user_id: State.user.id,
    deck_id: deckId,
    front: c.front,
    back: c.back,
    example: c.example || '',
    hint: '',
    tags: [],
    stage: 0,
    nextReview: 0,
    lastReview: 0,
    reviewCount: 0,
    mastered: false,
    wrongCount: 0,
    createdAt: new Date().toISOString()
  };
}

/* ============ 导入确认入口 ============ */
export function confirmImport(source = 'local') {
  const ta = document.getElementById('importText');
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) { toast('请输入内容', 'warning'); return; }

  const deckSel = document.getElementById('importDeck');
  const newDeckNameEl = document.getElementById('importNewDeckName');
  let deckId = deckSel ? deckSel.value : '';
  let deckName = '';
  let isNewDeck = false;

  if (deckId === '__new__') {
    deckName = (newDeckNameEl ? newDeckNameEl.value.trim() : '') || '新卡片组';
    isNewDeck = true;
  } else {
    const d = DB.decks.find(x => x.id === deckId);
    if (!d) { toast('卡片组不存在', 'error'); return; }
    deckName = d.name;
  }

  let cards;
  if (source === 'ai' && State._aiReviewedCards && State._aiReviewedCards.length) {
    cards = State._aiReviewedCards;
  } else {
    const parsed = parseLocal(text);
    cards = parsed.cards;
  }

  if (!cards.length) { toast('没有可导入的卡片', 'warning'); return; }

  /* 新建卡片组流程 */
  if (isNewDeck) {
    const newDeck = {
      id: uid(),
      user_id: State.user.id,
      name: deckName,
      description: '',
      color: '#7c6cf8',
      createdAt: new Date().toISOString()
    };
    DB.decks.push(newDeck);
    deckId = newDeck.id;
    save('decks');
  }

  /* ⭐ 去重检测 */
  const { newCards, dupCards } = checkDuplicates(cards, deckId);

  /* 没有重复 → 直接导入 */
  if (!dupCards.length) {
    newCards.forEach(c => DB.cards.push(buildCard(c, deckId)));
    save('cards');
    emit('db:changed');
    hideModal();
    State._aiReviewedCards = null;
    toast(`✅ 已导入 ${newCards.length} 张卡片到「${deckName}」`, 'success');
    rerender();
    return;
  }

  /* 有重复 → 弹窗让用户选 */
  showDedupeDialog({
    deckId, deckName, newCards, dupCards, source,
    onDone: () => {}
  });
}

/* ============ Actions ============ */
export const actions = {
  'card-import-open': (el) => {
    const deckId = el.dataset.deckId || State.reviewDeckId || null;
    showImportDialog(deckId);
  },

  'import-load-file': () => {
    const fi = document.getElementById('importFileInput');
    if (fi) fi.click();
  },

  'import-load-sample': () => {
    const ta = document.getElementById('importText');
    if (!ta) return;
    ta.value = [
      'abandon --- v. 放弃；抛弃 --- He abandoned the plan.',
      'benefit --- n. 利益；好处 v. 有益于',
      'crucial --- adj. 至关重要的 --- This is a crucial moment.',
      'decline --- v. 下降；婉拒 n. 衰退',
      'efficient --- adj. 高效的 --- She is an efficient worker.'
    ].join('\n');
    renderImportPreview();
    toast('已载入示例', 'success');
  },

  'import-clear': () => {
    const ta = document.getElementById('importText');
    if (ta) ta.value = '';
    const el = document.getElementById('importPreview');
    if (el) el.innerHTML = '';
    State._aiReviewedCards = null;
  },

  'import-ai-review': async () => {
    const ta = document.getElementById('importText');
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) { toast('请先输入内容', 'warning'); return; }
    if (!AIHub.isEnabled()) { toast('请先到设置启用 AI', 'warning'); return; }

    const deckSel = document.getElementById('importDeck');
    const newDeckNameEl = document.getElementById('importNewDeckName');
    let deckName = '';
    if (deckSel && deckSel.value === '__new__') {
      deckName = (newDeckNameEl ? newDeckNameEl.value.trim() : '') || '新卡片组';
    } else if (deckSel) {
      const d = DB.decks.find(x => x.id === deckSel.value);
      deckName = d ? d.name : '';
    }

    const el = document.getElementById('importPreview');
    if (el) {
      el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted)">
        <div style="font-size:32px;margin-bottom:8px">🤖</div>
        <div style="font-size:13px;font-weight:600">AI 审查中，请稍候…</div>
        <div style="font-size:11.5px;margin-top:6px">通常 3-10 秒</div>
      </div>`;
    }

    try {
      const cards = await aiReviewText(text, deckName);
      State._aiReviewedCards = cards;
      renderAIReviewed(cards, deckName);
      toast(`AI 整理出 ${cards.length} 张卡片`, 'success');
    } catch (e) {
      console.error('[AI review]', e);
      toast('AI 审查失败：' + e.message, 'error');
      renderImportPreview();
    }
  },

  'import-confirm': () => {
    const source = State._aiReviewedCards && State._aiReviewedCards.length ? 'ai' : 'local';
    confirmImport(source);
  },

  /* ⭐ 去重策略按钮 */
  'dedupe-skip': () => doImport('skip'),
  'dedupe-overwrite': () => doImport('overwrite'),
  'dedupe-import-all': () => doImport('all'),
  'dedupe-cancel': () => {
    State._dedupeCtx = null;
    hideModal();
    /* 重开导入弹窗 */
    setTimeout(() => showImportDialog(State.reviewDeckId), 60);
  }
};

/* 实时预览 */
document.addEventListener('input', e => {
  if (e.target && e.target.id === 'importText') {
    State._aiReviewedCards = null;
    clearTimeout(window._importPreviewTimer);
    window._importPreviewTimer = setTimeout(renderImportPreview, 300);
  }
});
// END OF FILE