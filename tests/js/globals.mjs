// Minimal stand-ins for the Firefox globals the modules use. Import before the module under test.
const prefs = new Map();
globalThis.Services = {
  io: { offline: false },
  prefs: {
    _get: (k, d) => (prefs.has(k) ? prefs.get(k) : d),
    getIntPref: (k, d) => (prefs.has(k) ? prefs.get(k) : d),
    getStringPref: (k, d) => (prefs.has(k) ? prefs.get(k) : d),
    getBoolPref: (k, d) => (prefs.has(k) ? prefs.get(k) : d),
    setIntPref: (k, v) => prefs.set(k, v),
    setStringPref: (k, v) => prefs.set(k, v),
    setBoolPref: (k, v) => prefs.set(k, v),
    _reset: () => prefs.clear(),
  },
};
const getters = new Map();
globalThis.ChromeUtils = {
  defineESModuleGetters(obj, map) {
    for (const [name, url] of Object.entries(map)) {
      Object.defineProperty(obj, name, {
        configurable: true,
        get: () => {
          const mod = getters.get(url);
          if (!mod) throw new Error(`mock module not preloaded: ${url}`);
          return mod[name];
        },
      });
    }
  },
  _preload: (url, mod) => getters.set(url, mod),
};
