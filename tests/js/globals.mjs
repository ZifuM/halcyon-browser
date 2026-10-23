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
    setBoolPref: (k, v) => {
      prefs.set(k, v);
      for (const [branch, fn] of observers) {
        if (k.startsWith(branch)) fn(null, "nsPref:changed", k);
      }
    },
    clearUserPref: k => prefs.delete(k),
    PREF_INVALID: 0,
    PREF_BOOL: 128,
    getPrefType: k => (typeof prefs.get(k) === "boolean" ? 128 : prefs.has(k) ? 32 : 0),
    addObserver: (branch, fn) => observers.push([branch, fn]),
    _reset: () => prefs.clear(),
  },
};
const observers = [];

// In-memory IOUtils / PathUtils (just what our modules use).
const files = new Map();
const notFound = path => Object.assign(new Error(`not found: ${path}`), { name: "NotFoundError", __dom: true });
globalThis.DOMException = globalThis.DOMException ?? class extends Error {};
globalThis.DOMException.isInstance = e => !!e?.__dom;
globalThis.PathUtils = {
  profileDir: "/profile",
  join: (...parts) => parts.join("/"),
};
globalThis.IOUtils = {
  _files: files,
  async read(path) {
    if (!files.has(path)) throw notFound(path);
    return new TextEncoder().encode(files.get(path));
  },
  async readJSON(path) {
    if (!files.has(path)) throw notFound(path);
    return JSON.parse(files.get(path));
  },
  async writeUTF8(path, text) {
    files.set(path, text);
  },
  async writeJSON(path, value) {
    files.set(path, JSON.stringify(value));
  },
  async makeDirectory() {},
};

// Fake content classifier service, reachable through Cc/Ci like the real one.
globalThis.__classifierCalls = [];
globalThis.Ci = { nsIContentClassifierService: "nsIContentClassifierService" };
globalThis.Cc = {
  "@mozilla.org/content-classifier-service;1": {
    getService: () => ({
      onListsChanged: (updated, removed) => globalThis.__classifierCalls.push({ updated, removed }),
    }),
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
