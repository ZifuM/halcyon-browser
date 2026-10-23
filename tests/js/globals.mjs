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

// Fake content classifier service, reachable through Cc/Ci like the real one. Element-hiding
// answers come from globalThis.__cosmetic (set per test); `throws` simulates "not initialised".
globalThis.__classifierCalls = [];
globalThis.__cosmetic = { hide: [], procedural: [], exceptions: [], generichide: false, generic: () => [] };
globalThis.Ci = { nsIContentClassifierService: "nsIContentClassifierService" };
globalThis.Cc = {
  "@mozilla.org/content-classifier-service;1": {
    getService: () => ({
      onListsChanged: (updated, removed) => globalThis.__classifierCalls.push({ updated, removed }),
      getCosmeticResources(url, pb, hide, procedural, exceptions, script, generichide) {
        const c = globalThis.__cosmetic;
        globalThis.__classifierCalls.push({ cosmetic: url, pb });
        if (c.throws) throw new Error("NS_ERROR_NOT_INITIALIZED");
        hide.value = c.hide;
        procedural.value = c.procedural;
        exceptions.value = c.exceptions;
        script.value = "";
        generichide.value = c.generichide;
      },
      getHiddenClassIdSelectors(pb, classes, ids, exceptions) {
        globalThis.__classifierCalls.push({ generic: { classes, ids, exceptions }, pb });
        if (globalThis.__cosmetic.throws) throw new Error("NS_ERROR_NOT_INITIALIZED");
        return globalThis.__cosmetic.generic(classes, ids, exceptions);
      },
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
  _actors: new Map(),
  registerWindowActor(name, options) {
    if (this._actors.has(name)) throw new Error(`actor ${name} registered twice`);
    this._actors.set(name, options);
  },
};

// JSWindowActor base classes: tests set browsingContext / document / contentWindow and route
// sendQuery to a parent instance.
globalThis.JSWindowActorParent = class {};
globalThis.JSWindowActorChild = class {
  sendQuery(name, data) {
    if (!this._parent) return Promise.reject(new Error("no parent"));
    // Structured clone, like the real IPC boundary.
    return Promise.resolve(structuredClone(this._parent.receiveMessage({ name, data: structuredClone(data) })));
  }
};
