/* 公式求值工具
 * 支持：+ - * / ( ) ^ 和函数 min max abs round floor ceil sqrt pow
 * 变量名：字母/下划线/数字/中文，如 weight / 体重
 * 安全：白名单字符 + 拦截 constructor / __proto__ 等
 */

const ALLOWED_FN = ['min', 'max', 'abs', 'round', 'floor', 'ceil', 'sqrt', 'pow'];

export function extractVars(formula) {
  if (!formula || typeof formula !== 'string') return [];
  const set = new Set();
  const re = /[a-zA-Z_\u4e00-\u9fa5][a-zA-Z0-9_\u4e00-\u9fa5]*/g;
  let m;
  while ((m = re.exec(formula)) !== null) {
    if (!ALLOWED_FN.includes(m[0])) set.add(m[0]);
  }
  return [...set];
}

export function evaluateFormula(formula, vars) {
  if (!formula || typeof formula !== 'string') return null;
  let expr = String(formula).trim().replace(/\^/g, '**');
  if (!expr) return null;

  // 白名单字符
  if (!/^[\d+\-*/().,*%\s a-zA-Z_\u4e00-\u9fa5]+$/.test(expr)) return null;

  // 危险关键字拦截
  if (/constructor|prototype|__proto__|eval|Function|window|document|globalThis|import|require/i.test(expr)) {
    return null;
  }

  // 标识符替换
  expr = expr.replace(/[a-zA-Z_\u4e00-\u9fa5][a-zA-Z0-9_\u4e00-\u9fa5]*/g, m => {
    if (ALLOWED_FN.includes(m)) return `Math.${m}`;
    return `(vars[${JSON.stringify(m)}] ?? null)`;
  });

  try {
    const fn = new Function('vars', `"use strict"; return (${expr});`);
    const r = fn(vars);
    if (typeof r !== 'number' || !isFinite(r)) return null;
    return r;
  } catch {
    return null;
  }
}

/* 校验公式：语法 + 变量 */
export function validateFormula(formula) {
  if (!formula || !formula.trim()) return { ok: true, vars: [] };
  const vars = extractVars(formula);
  const fake = {};
  vars.forEach(v => { fake[v] = 1; });
  const r = evaluateFormula(formula, fake);
  if (r === null) return { ok: false, error: '公式语法错误', vars };
  return { ok: true, vars };
}
// END OF FILE