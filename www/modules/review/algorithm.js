export const STAGES = [
  { label: '5 分钟',  ms: 5 * 60 * 1000 },
  { label: '30 分钟', ms: 30 * 60 * 1000 },
  { label: '12 小时', ms: 12 * 60 * 60 * 1000 },
  { label: '1 天',    ms: 24 * 60 * 60 * 1000 },
  { label: '2 天',    ms: 2 * 24 * 60 * 60 * 1000 },
  { label: '4 天',    ms: 4 * 24 * 60 * 60 * 1000 },
  { label: '7 天',    ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '15 天',   ms: 15 * 24 * 60 * 60 * 1000 }
];
export const MAX_STAGE = STAGES.length - 1;

/* ⭐ 应用评分：更新阶段 + 错题计数 */
export function applyRating(card, rating) {
  let stage = card.stage || 0;
  if (rating === 1) stage = 0;
  else if (rating === 2) stage = Math.max(0, stage - 1);
  else stage = Math.min(MAX_STAGE, stage + 1);

  /* ⭐ 错题计数：答错 +1，答对 -1（最低 0） */
  if (rating === 1) {
    card.wrongCount = (card.wrongCount || 0) + 1;
  } else if (rating === 3) {
    card.wrongCount = Math.max(0, (card.wrongCount || 0) - 1);
  }

  card.stage = stage;
  card.lastReview = Date.now();
  card.nextReview = Date.now() + STAGES[stage].ms;
  card.reviewCount = (card.reviewCount || 0) + 1;
  card.mastered = stage >= MAX_STAGE;
  return card;
}

export function isDue(card, now = Date.now()) {
  if (card.mastered) return false;
  return (card.nextReview || 0) <= now;
}

export function classifyCards(cards, now = Date.now()) {
  const due = [];
  const learning = [];
  const mastered = [];
  cards.forEach(c => {
    if (c.mastered) mastered.push(c);
    else if (isDue(c, now)) due.push(c);
    else learning.push(c);
  });
  due.sort((a, b) => (a.nextReview || 0) - (b.nextReview || 0));
  return { due, learning, mastered };
}

export function humanNextReview(card) {
  if (card.mastered) return '已掌握';
  const now = Date.now();
  const d = (card.nextReview || 0) - now;
  if (d <= 0) return '待复习';
  const min = Math.round(d / 60000);
  if (min < 60) return `${min} 分钟后`;
  const h = Math.round(d / 3600000);
  if (h < 24) return `${h} 小时后`;
  const day = Math.round(d / 86400000);
  return `${day} 天后`;
}

export function cardProgress(card) {
  return (card.stage || 0) / MAX_STAGE;
}
// END OF FILE