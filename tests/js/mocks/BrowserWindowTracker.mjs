export const BrowserWindowTracker = {
  getTopWindow: () => globalThis.__testWindow ?? null,
};
