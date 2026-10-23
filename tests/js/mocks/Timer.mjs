// Intervals are recorded, not scheduled, so tests stay deterministic and Node can exit.
export const intervals = [];
export function setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; }
export function clearInterval() {}
export function setTimeout(fn, ms) { const t = globalThis.setTimeout(fn, ms); t.unref?.(); return t; }
export function clearTimeout(t) { globalThis.clearTimeout(t); }
