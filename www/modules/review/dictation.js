import { DB, State, save } from '../../core/db.js';
import { esc, uid, today } from '../../core/utils.js';
import { toast } from '../../ui/toast.js';
import { emit } from '../../core/bus.js';
import { rerender } from '../../ui/shell.js';
import { applyRating } from './algorithm.js';

let session = null;
let _resetUserId = null;

/* ⭐ 切用户时清空 session + 移除 overlay */
export function resetForUser(userId) {
  if (_resetUserId === userId) return;
  _resetUserId = userId;
  session = null;
  const ov = document.getElementById('dictationOverlay');
  if (ov) ov.remove();
}

function isDictable(card) {
  if (!card || !card.front || !card.back) return false;
  const front = card.front.trim();
  if (front.length === 0 || front.length > 80) return false;
  const hasLetter = /[a-zA-Z]/.test(front);
  const hasChinese = /[\u4e00-\u9fa5]/.test(front);
  if (!hasLetter || hasChinese) return false;
  const backHasChinese = /[\u4e00-\u9fa5]/.test(card.back);
  return backHasChinese;
}

function pickDictableCards(deckId) {
  return DB.cards.filter(c =>
    c.user_id === State.user.id &&
    c.deck_id === deckId &&
    isDictable(c)
  );
}

function normalizeAnswer(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,!?;:'"“”‘’（）()\[\]【】]/g, '')
    .trim();
}

function checkAnswer(input, correct) {
  const a = normalizeAnswer(input);
  const b = normalizeAnswer(correct);
  if (!a) return { ok: false, level: 'empty' };
  if (a === b) return { ok: true, level: 'exact' };
  const alts = correct.split(/[\/／|]/).map(s => normalizeAnswer(s));
  if (alts.some(x => x === a)) return { ok: true, level: 'exact' };
  const dist = levenshtein(a, b);
  if (dist <= 2 && Math.abs(a.length - b.length) <= 2) return { ok: true, level: 'near', distance: dist };
  return { ok: false, level: 'wrong', distance: dist };
}

function levenshtein(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

function generateHint(word) {
  const w = String(word || '').trim();
  if (!w) return { reveal: [], masked: '', len: 0, revealCount: 0 };
  const len = w.length;

  let revealCount = 1;
  if (len >= 9) revealCount = 2;
  else if (len >= 6 && Math.random() < 0.5) revealCount = 2;

  const candidates = [];
  for (let i = 0; i < len; i++) {
    if (/[a-zA-Z]/.test(w[i])) candidates.push(i);
  }
  if (candidates.length <= revealCount) {
    revealCount = candidates.length;
  }

  const positions = [];
  while (positions.length < revealCount && candidates.length) {
    const i = Math.floor(Math.random() * candidates.length);
    positions.push(candidates[i]);
    candidates.splice(i, 1);
  }
  positions.sort((a, b) => a - b);

  const display = w.split('').map((ch, i) => {
    if (positions.includes(i)) return ch;
    if (/[a-zA-Z]/.test(ch)) return '_';
    return ch;
  }).join(' ');

  return { reveal: positions, masked: display, len, revealCount };
}

function maskWordInExample(example, word) {
  if (!example || !word) return example || '';
  const w = String(word).trim();
  if (!w) return example;
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const re = new RegExp('\\b' + escaped + '\\b', 'gi');
    return String(example).replace(re, m => '_'.repeat(m.length));
  } catch (e) {
    return example;
  }
}

export function startDictation(deckId, shuffle = true) {
  let cards = pickDictableCards(deckId);
  if (!cards.length) {
    toast('这个卡片组没有可默写的英文卡片', 'warning');
    return;
  }
  if (shuffle) cards = [...cards].sort(() => Math.random() - 0.5);
  cards = cards.slice(0, 30);

  const deck = DB.decks.find(d => d.id === deckId);

  const hints = {};
  cards.forEach(c => { hints[c.id] = generateHint(c.front); });

  session = {
    deckId,
    deckName: deck ? deck.name : '默写',
    cardIds: cards.map(c => c.id),
    hints,
    idx: 0,
    input: '',
    feedback: null,
    correctAnswer: '',
    correct: 0,
    wrong: 0,
    results: []
  };
  render();
}

export function render() {
  if (!session) return;
  const old = document.getElementById('dictationOverlay');
  if (old) old.remove();

  if (session.idx >= session.cardIds.length) {
    renderResult();
    return;
  }

  const card = DB.cards.find(c => c.id === session.cardIds[session.idx]);
  if (!card) { session.idx++; render(); return; }

  const hint = session.hints[card.id] || { masked: '', len: 0 };

  const overlay = document.createElement('div');
  overlay.id = 'dictationOverlay';
  overlay.className = 'review-overlay';

  const fb = session.feedback;
  const fbCls = fb ? `feedback-${fb.level}` : '';
  const fbText = fb ? ({
    exact: '✅ 正确',
    near: `⚠️ 拼写接近（差 ${fb.distance} 个字母）`,
    wrong: '❌ 拼写错误',
    empty: '请输入答案'
  }[fb.level] || '') : '';

  const exampleHtml = (() => {
    if (!card.example) return '';
    if (!fb) return '';
    return `<div class="df-example">例句：${esc(maskWordInExample(card.example, card.front))}</div>`;
  })();

  overlay.innerHTML = `
    <div class="review-panel dictation-panel">
      <div class="review-head">
        <div class="review-deck-name">✍️ 默写 · ${esc(session.deckName)}</div>
        <div class="review-progress">${session.idx + 1} / ${session.cardIds.length}</div>
        <button class="review-exit" data-action="dictation-exit" type="button" title="退出">✕</button>
      </div>
      <div class="review-progress-bar">
        <div class="review-progress-fill" style="width:${(session.idx / session.cardIds.length) * 100}%"></div>
      </div>

      <div class="dictation-body">
        <div class="dictation-prompt">${esc(card.back)}</div>
        ${hint.masked ? `
          <div class="dictation-hint">
            <span class="dh-label">提示</span>
            <span class="dh-mask">${esc(hint.masked)}</span>
            <span class="dh-len">共 ${hint.len} 字符 · 已揭示 ${hint.revealCount} 个字母</span>
          </div>
        ` : ''}
      </div>

      <div class="dictation-input-row">
        <input type="text" class="input dictation-input ${fbCls}" id="dictationInput"
               placeholder="输入英文单词..." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
               value="${esc(session.input)}" ${fb ? 'disabled' : ''}>
        ${!fb ? `
          <button class="btn btn-primary" data-action="dictation-submit" type="button">提交</button>
        ` : `
          <button class="btn btn-primary" data-action="dictation-next" type="button">下一题 →</button>
        `}
      </div>

      ${fb ? `
        <div class="dictation-feedback ${fbCls}">
          <div class="df-result">${fbText}</div>
          <div class="df-correct">
            正确答案：<b>${esc(session.correctAnswer)}</b>
          </div>
          ${exampleHtml}
        </div>
      ` : `
        <div class="dictation-tip">按 Enter 提交 · Esc 退出</div>
      `}
    </div>
  `;
  document.body.appendChild(overlay);

  if (!fb) {
    setTimeout(() => {
      const inp = document.getElementById('dictationInput');
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }, 60);
  } else {
    setTimeout(() => {
      const btn = document.querySelector('[data-action="dictation-next"]');
      if (btn) btn.focus();
    }, 60);
  }
}

export function submit() {
  if (!session || session.feedback) return;
  const inp = document.getElementById('dictationInput');
  if (!inp) return;
  const input = inp.value.trim();
  const card = DB.cards.find(c => c.id === session.cardIds[session.idx]);
  if (!card) return;

  const result = checkAnswer(input, card.front);
  session.input = input;
  session.correctAnswer = card.front;

  if (result.level === 'empty') {
    toast('请输入答案', 'warning');
    return;
  }

  session.feedback = result;

  if (result.ok) {
    session.correct++;
    const prevStage = card.stage || 0;
    applyRating(card, 3);
    saveCardReview(card, 3, prevStage, 'dictation');
  } else {
    session.wrong++;
    const prevStage = card.stage || 0;
    applyRating(card, 1);
    saveCardReview(card, 1, prevStage, 'dictation');
  }
  session.results.push({ cardId: card.id, ok: result.ok, level: result.level });
  render();
}

function saveCardReview(card, rating, prevStage, mode) {
  DB.reviewLogs.push({
    id: uid(),
    user_id: State.user.id,
    card_id: card.id,
    deck_id: card.deck_id,
    date: today(),
    rating,
    prevStage,
    nextStage: card.stage,
    mode,
    reviewedAt: new Date().toISOString()
  });
  save('cards', 'reviewLogs');
  emit('db:changed');
}

export function next() {
  if (!session) return;
  session.idx++;
  session.input = '';
  session.feedback = null;
  session.correctAnswer = '';
  render();
}

function renderResult() {
  if (!session) return;
  const total = session.results.length;
  const correct = session.correct;
  const wrong = session.wrong;
  const pct = total ? Math.round(correct / total * 100) : 0;

  const overlay = document.createElement('div');
  overlay.id = 'dictationOverlay';
  overlay.className = 'review-overlay';
  overlay.innerHTML = `
    <div class="review-panel review-result-panel">
      <div class="review-result">
        <div class="review-result-icon">${pct >= 80 ? '🎉' : pct >= 50 ? '💪' : '📚'}</div>
        <div class="review-result-title">默写完成</div>
        <div class="review-result-sub">${esc(session.deckName)} · 正确率 ${pct}%</div>

        <div class="review-result-stats">
          <div class="rrs-item"><span class="rrs-num">${total}</span><span class="rrs-label">总计</span></div>
          <div class="rrs-item rrs-good"><span class="rrs-num">${correct}</span><span class="rrs-label">✅ 正确</span></div>
          <div class="rrs-item rrs-again"><span class="rrs-num">${wrong}</span><span class="rrs-label">❌ 错误</span></div>
          <div class="rrs-item"><span class="rrs-num">${pct}%</span><span class="rrs-label">正确率</span></div>
        </div>

        <div class="review-result-tip">
          ${pct >= 90 ? '太棒了，基本都掌握了！' :
            pct >= 70 ? '不错的成绩，个别单词再巩固一下' :
            pct >= 50 ? '一半以上掌握了，多复习几遍' :
            '还需要多练习，错词会按遗忘曲线提醒复习'}
        </div>

        <div class="review-result-actions">
          <button class="btn" data-action="dictation-again" type="button">🔄 再来一轮</button>
          <button class="btn btn-primary" data-action="dictation-finish" type="button">完成</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function exit() {
  session = null;
  const old = document.getElementById('dictationOverlay');
  if (old) old.remove();
  rerender();
}

export const actions = {
  'dictation-start': (el) => {
    const deckId = el.dataset.id || State.reviewDeckId;
    if (deckId) startDictation(deckId);
  },

  'dictation-submit': () => submit(),
  'dictation-next': () => next(),

  'dictation-exit': () => {
    if (session && session.idx > 0 && session.idx < session.cardIds.length) {
      if (!confirm('退出默写？已完成的进度会保存')) return;
    }
    exit();
  },

  'dictation-again': () => {
    if (!session) return;
    const deckId = session.deckId;
    exit();
    startDictation(deckId);
  },

  'dictation-finish': () => {
    exit();
  }
};

document.addEventListener('keydown', e => {
  if (!session) return;
  const overlay = document.getElementById('dictationOverlay');
  if (!overlay) return;

  if (e.key === 'Enter') {
    if (session.feedback) { e.preventDefault(); next(); }
    else { e.preventDefault(); submit(); }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    actions['dictation-exit']();
    return;
  }
});

document.addEventListener('input', e => {
  if (e.target && e.target.id === 'dictationInput' && session) {
    session.input = e.target.value;
  }
});