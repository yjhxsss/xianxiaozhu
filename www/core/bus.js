const listeners = {};
export function on(event, fn) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(fn);
  return () => off(event, fn);
}
export function off(event, fn) {
  if (!listeners[event]) return;
  listeners[event] = listeners[event].filter(f => f !== fn);
}
export function emit(event, data) {
  (listeners[event] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
}