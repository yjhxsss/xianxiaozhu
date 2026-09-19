import { DB, State, save } from '../../core/db.js';
import { uid } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { show as showModal, hide as hideModal } from '../../ui/modal.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';
import { AIHub } from '../diary/ai.js';
import { showImportDialog } from './importer.js';

/* ============ AI 生成卡片 ============ */
export async function aiGenerateCards({ deckName, scope, count, existingFronts }) {
  if (!AIHub.isEnabled()) throw new Error('AI 未启用，请到设置开启');

  const existing = (existingFronts || []).slice(0, 30);
  const prompt = `请为学习卡片组「${deckName}」生成 ${count} 张卡片。

【卡片组主题】${deckName}
${scope ? `【学习范围/要求】\n${scope}\n` : ''}
【已有卡片（避免重复）】
${existing.length ? existing.join('\n') : '（无）'}

【要求】
1. 严格返回 JSON 数组，不要任何 markdown 标记
2. 每张卡片：
   - front：正面 / 问题（简短，10-30 字）
   - back：背面 / 答案（清晰，说明要点）
   - example：例句或补充说明（可选，可空字符串）
3. 内容要**准确、有学习价值**，不要编造。不确定的内容不要生成。
4. 如果你熟悉这个主题，尽量覆盖核心知识点，不要重复。

【输出格式】
[
  {"front":"abandon","back":"v. 放弃；抛弃","example":"He abandoned the plan."},
  {"front":"benefit","back":"n. 利益；好处  v. 有益于","example":"Regular exercise benefits health."}
]`;

  const text = await AIHub.chat([
    { role: 'system', content: '你是一个学习卡片生成助手，只输出严格 JSON 数组。' },
    { role: 'user', content: prompt }
  ], { temperature: 0.6, maxTokens: 3000 });

  let s = String(text).replace(/```json|```/g, '').trim();
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
    .slice(0, count)
    .map(x => ({
      id: uid(),
      front: String(x.front).trim().slice(0, 200),
      back: String(x.back).trim().slice(0, 500),
      example: String(x.example || '').trim().slice(0, 300),
      selected: true
    }));
}

/* ============ AI 生成弹窗 ============ */
export function showAIGenerateModal(opts = {}) {
  if (!AIHub.isEnabled()) {
    toast('请先到设置启用 AI', 'warning');
    return;
  }

  const decks = DB.decks.filter(d => d.user_id === State.user.id);
  const presetDeckId = opts.deckId || State.reviewDeckId || '';
  const deckOptions = decks.map(d =>
    `<option value="${d.id}"${presetDeckId === d.id ? ' selected' : ''}>${d.name}</option>`
  ).join('');

  showModal('aiGenerateCards', `
    <h3 style="font-size:16px;margin-bottom:12px;font-weight:800">🤖 AI 生成素材</h3>
    <div class="hint-box" style="margin-bottom:14px">
      让 AI 帮你生成一批学习卡片。给它一个主题和范围，它会输出结构化的卡片。
    </div>

    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px;font-weight:600">目标卡片组</label>
      <select class="input" id="aiGenDeck">
        <option value="__new__">+ 新建卡片组</option>
        ${deckOptions}
      </select>
    </div>

    <div id="aiGenNewDeckRow" class="${presetDeckId ? 'hidden' : ''}" style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px;font-weight:600">新卡片组名称</label>
      <input type="text" class="input" id="aiGenNewDeckName" placeholder="如：英语四级核心词 / 申论素材 / 政治考点">
    </div>

    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px;font-weight:600">学习范围 / 要求（可选）</label>
      <textarea class="input" id="aiGenScope" style="min-height:70px;font-size:12.5px;line-height:1.6" placeholder="如：大学英语四级高频词汇，覆盖动词、名词、形容词；或：高中政治必修一全部核心概念"></textarea>
    </div>

    <div style="margin-bottom:12px">
      <label style="font-size:12.5px;color:var(--text-sec);display:block;margin-bottom:6px;font-weight:600">生成数量</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="number" class="input" id="aiGenCount" value="20" min="5" max="60" style="max-width:100px">
        <span style="font-size:12px;color:var(--text-muted);font-weight:600">张（5-60）</span>
        ${[10, 20, 30, 50].map(n => `<button class="btn btn-xs btn-ghost" data-action="ai-gen-quick" data-count="${n}" type="button">${n}</button>`).join('')}
      </div>
    </div>

    <div style="display:flex;gap:10px;justify-content:space-between;align-items:center;margin-top:16px;flex-wrap:wrap">
      <button class="btn btn-sm btn-ghost" data-action="card-import-open" type="button">📄 用文件/文本导入</button>
      <div style="display:flex;gap:10px">
        <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
        <button class="btn btn-sm btn-primary" data-action="ai-gen-run" type="button">🤖 生成</button>
      </div>
    </div>
  `, 'lg');

  /* 联动：选"新建"时显示输入框 */
  setTimeout(() => {
    const sel = document.getElementById('aiGenDeck');
    const row = document.getElementById('aiGenNewDeckRow');
    if (sel && row) {
      const toggle = () => row.classList.toggle('hidden', sel.value !== '__new__');
      sel.addEventListener('change', toggle);
      toggle();
    }
  }, 60);
}

/* ============ 渲染生成结果（可编辑、可勾选） ============ */
export function renderGeneratedCards() {
  const cached = State._aiGeneratedCards;
  if (!cached) return;

  const selected = cached.cards.filter(c => c.selected).length;
  showModal('aiGenerateCards', `
    <h3 style="font-size:16px;margin-bottom:8px;font-weight:800">🤖 AI 生成结果</h3>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px">
      目标：<b style="color:var(--text)">${esc(cached.deckName)}</b>
      · 已选 ${selected}/${cached.cards.length}
    </div>
    <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:10px;line-height:1.6">
      💡 可以直接编辑每张卡片的内容，确认后「全部采纳」
    </div>

    <div class="ai-gen-list">
      ${cached.cards.map((c, i) => `
        <div class="ai-gen-item ${c.selected ? 'selected' : ''}" data-gen-idx="${i}">
          <div class="ai-gen-check" data-action="ai-gen-toggle" data-idx="${i}" role="button">
            ${c.selected ? '☑' : '☐'}
          </div>
          <div class="ai-gen-fields">
            <input type="text" class="ai-gen-input ai-gen-front" data-idx="${i}" data-field="front" value="${esc(c.front)}" placeholder="正面">
            <textarea class="ai-gen-input ai-gen-back" data-idx="${i}" data-field="back" placeholder="背面">${esc(c.back)}</textarea>
            <input type="text" class="ai-gen-input ai-gen-example" data-idx="${i}" data-field="example" value="${esc(c.example)}" placeholder="例句（可选）">
          </div>
        </div>
      `).join('')}
    </div>

    <div style="display:flex;gap:10px;justify-content:space-between;margin-top:16px;flex-wrap:wrap">
      <button class="btn btn-sm btn-ghost" data-action="ai-gen-regen" type="button">🔄 重新生成</button>
      <div style="display:flex;gap:10px">
        <button class="btn btn-sm" data-action="modal-close" type="button">取消</button>
        <button class="btn btn-sm btn-primary" data-action="ai-gen-accept-all" type="button">✓ 全部采纳（${selected}）</button>
      </div>
    </div>
  `, 'lg');
}

/* 简单 esc（这里内联一份，避免循环 import） */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}
// END OF FILE