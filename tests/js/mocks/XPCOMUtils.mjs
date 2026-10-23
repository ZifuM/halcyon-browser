export const XPCOMUtils = {
  defineLazyServiceGetter(obj, name, contract, iface) {
    Object.defineProperty(obj, name, {
      configurable: true,
      get: () => globalThis.Cc[contract].getService(globalThis.Ci[iface] ?? iface),
    });
  },
  defineLazyPreferenceGetter(obj, name, pref, fallback) {
    Object.defineProperty(obj, name, {
      configurable: true,
      get: () => globalThis.Services.prefs._get(pref, fallback),
    });
  },
};
