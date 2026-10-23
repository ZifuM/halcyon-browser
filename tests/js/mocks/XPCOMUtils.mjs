export const XPCOMUtils = {
  defineLazyPreferenceGetter(obj, name, pref, fallback) {
    Object.defineProperty(obj, name, {
      configurable: true,
      get: () => globalThis.Services.prefs._get(pref, fallback),
    });
  },
};
