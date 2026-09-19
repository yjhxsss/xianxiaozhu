const modules = [];
export function register(module) {
  if (!module.id) throw new Error('模块必须有 id');
  modules.push(module);
  modules.sort((a, b) => (a.order || 999) - (b.order || 999));
}
export function getModules() { return modules; }
export function getModule(id) { return modules.find(m => m.id === id); }