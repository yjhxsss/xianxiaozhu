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
  const ov = document.getElementById('quizOverlay');
  if (ov) ov.remove();
}

export function startQuiz(deckId, count = 10) {
  const cards = DB.cards.filter(c => c.user_id === State.user.id && c.deck_id === deckId);
  if (cards.length < 2) {
    toast('至少需要 2 张卡片才能生成测试', 'warning');
    return;
  }
  const picked = [...cards].sort(() => Math.random() - 0.5).slice(0, Math.min(count, cards.length));

  const deck = DB.decks.find(d => d.id === deckId);

  const questions = picked.map(card => {
    const correct = card.back;
    const pool = [...cards]
      .filter(c => c.id !== card.id && c.back !== correct)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3)
      .map(c => c.back);
    const options = [correct, ...pool];
    options.sort(() => Math.random() - 0.5);
    return {
      cardId: card.id,
      prompt: card.front,
      correct,
      options
    };
  });

  session = {
    deckId,
    deckName: deck ? deck.name : '测试',
    questions,
    idx: 0,
    selected: null,
    revealed: false,
    correct: 0,
    wrong: 0
  };
  render();
}

export function render() {
  if (!session) return;
  const old = document.getElementById('quizOverlay');
  if (old) old.remove();

  if (session.idx >= session.questions.length) {
    renderResult();
    return;
  }

  const q = session.questions[session.idx];
  const overlay = document.createElement('div');
  overlay.id = 'quizOverlay';
  overlay.className = 'review-overlay';

  const optionHtml = q.options.map((opt, i) => {
    let cls = 'quiz-option';
    if (session.revealed) {
      if (opt === q.correct) cls += ' correct';
      else if (opt === session.selected) cls += ' wrong';
      else cls += ' dim';
    } else if (opt === session.selected) {
      cls += ' picked';
    }
    return `
      <button class="${cls}" data-action="quiz-pick" data-opt="${esc(opt)}" type="button" ${session.revealed ? 'disabled' : ''}>
        <span class="qo-marker">${String.fromCharCode(65 + i)}</span>
        <span class="qo-text">${esc(opt)}</span>
      </button>`;
  }).join('');

  overlay.innerHTML = `
    <div class="review-panel quiz-panel">
      <div class="review-head">
        <div class="review-deck-name">🎲 随机测试 · ${esc(session.deckName)}</div>
        <div class="review-progress">${session.idx + 1} / ${session.questions.length}</div>
        <button class="review-exit" data-action="quiz-exit" type="button" title="退出">✕</button>
      </div>
      <div class="review-progress-bar">
        <div class="review-progress-fill" style="width:${(session.idx / session.questions.length) * 100}%"></div>
      </div>

      <div class="quiz-body">
        <div class="quiz-prompt-label">请选择正确答案</div>
        <div class="quiz-prompt">${esc(q.prompt)}</div>
        <div class="quiz-options">${optionHtml}</div>
      </div>

      ${session.revealed ? `
        <div class="quiz-feedback ${session.selected === q.correct ? 'correct' : 'wrong'}">
          ${session.selected === q.correct
            ? `<span>✅ 答对了</span>`
            : `<span>❌ 答错了</span><span style="margin-left:12px">正确答案：<b>${esc(q.correct)}</b></span>`}
        </div>
        <div style="padding: 0 20px 16px; display: flex; justify-content: flex-end;">
          <button class="btn btn-primary" data-action="quiz-next" type="button">下一题 →</button>
        </div>
      ` : `
        <div class="quiz-tip">点击选项作答 · Esc 退出</div>
      `}
    </div>
  `;
  document.body.appendChild(overlay);
}

export function pick(opt) {
  if (!session || session.revealed) return;
  const q = session.questions[session.idx];
  if (!q) return;
  session.selected = opt;
  session.revealed = true;

  const ok = opt === q.correct;
  if (ok) session.correct++;
  else session.wrong++;

  const card = DB.cards.find(c => c.id === q.cardId);
  if (card) {
    const prevStage = card.stage || 0;
    applyRating(card, ok ? 3 : 1);
    DB.reviewLogs.push({
      id: uid(),
      user_id: State.user.id,
      card_id: card.id,
      deck_id: card.deck_id,
      date: today(),
      rating: ok ? 3 : 1,
      prevStage,
      nextStage: card.stage,
      mode: 'quiz',
      reviewedAt: new Date().toISOString()
    });
    save('cards', 'reviewLogs');
    emit('db:changed');
  }

  render();
}

export function next() {
  if (!session) return;
  session.idx++;
  session.selected = null;
  session.revealed = false;
  render();
}

function renderResult() {
  if (!session) return;
  const total = session.questions.length;
  const pct = total ? Math.round(session.correct / total * 100) : 0;

  const overlay = document.createElement('div');
  overlay.id = 'quizOverlay';
  overlay.className = 'review-overlay';
  overlay.innerHTML = `
    <div class="review-panel review-result-panel">
      <div class="review-result">
        <div class="review-result-icon">${pct >= 80 ? '🏆' : pct >= 50 ? '💪' : '📚'}</div>
        <div class="review-result-title">测试完成</div>
        <div class="review-result-sub">${esc(session.deckName)} · 正确率 ${pct}%</div>

        <div class="review-result-stats">
          <div class="rrs-item"><span class="rrs-num">${total}</span><span class="rrs-label">总计</span></div>
          <div class="rrs-item rrs-good"><span class="rrs-num">${session.correct}</span><span class="rrs-label">✅ 正确</span></div>
          <div class="rrs-item rrs-again"><span class="rrs-num">${session.wrong}</span><span class="rrs-label">❌ 错误</span></div>
          <div class="rrs-item"><span class="rrs-num">${pct}%</span><span class="rrs-label">正确率</span></div>
        </div>

        <div class="review-result-tip">
          ${pct >= 90 ? '太强了，这个卡片组基本掌握了！' :
            pct >= 70 ? '掌握得不错，错题会重新进入遗忘曲线' :
            pct >= 50 ? '还需要多复习几遍' :
            '基础还不够扎实，建议回默写模式加强'}
        </div>

        <div class="review-result-actions">
          <button class="btn" data-action="quiz-again" type="button">🔄 再来一轮</button>
          <button class="btn btn-primary" data-action="quiz-finish" type="button">完成</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function exit() {
  session = null;
  const old = document.getElementById('quizOverlay');
  if (old) old.remove();
  rerender();
}

export const actions = {
  'quiz-start': (el) => {
    const deckId = el.dataset.id || State.reviewDeckId;
    const count = parseInt(el.dataset.count) || 10;
    if (deckId) startQuiz(deckId, count);
  },

  'quiz-pick': (el) => {
    pick(el.dataset.opt);
  },

  'quiz-next': () => next(),

  'quiz-exit': () => {
    if (session && session.idx > 0 && session.idx < session.questions.length) {
      if (!confirm('退出测试？已答题目会保存')) return;
    }
    exit();
  },

  'quiz-again': () => {
    if (!session) return;
    const deckId = session.deckId;
    const count = session.questions.length;
    exit();
    startQuiz(deckId, count);
  },

  'quiz-finish': () => {
    exit();
  }
};

document.addEventListener('keydown', e => {
  if (!session) return;
  const overlay = document.getElementById('quizOverlay');
  if (!overlay) return;

  if (e.key === 'Escape') { e.preventDefault(); actions['quiz-exit'](); return; }
  if (session.revealed && e.key === 'Enter') { e.preventDefault(); next(); return; }
  if (!session.revealed) {
    const k = e.key.toUpperCase();
    const idx = 'ABCD'.indexOf(k);
    const q = session.questions[session.idx];
    if (idx >= 0 && q && q.options[idx]) { e.preventDefault(); pick(q.options[idx]); }
  }
});