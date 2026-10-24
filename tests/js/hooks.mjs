import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const MOCKS = {
  "resource://gre/modules/XPCOMUtils.sys.mjs": "mocks/XPCOMUtils.mjs",
  "resource://gre/modules/Timer.sys.mjs": "mocks/Timer.mjs",
  "resource:///modules/BrowserWindowTracker.sys.mjs": "mocks/BrowserWindowTracker.mjs",
  "moz-src:///browser/components/peryn/PerynBuildInfo.sys.mjs": "mocks/PerynBuildInfo.mjs",
};
const MOZ_SRC = "moz-src:///";

export async function resolve(specifier, context, next) {
  if (MOCKS[specifier]) {
    return { url: pathToFileURL(path.join(here, MOCKS[specifier])).href, shortCircuit: true, format: "module" };
  }
  if (specifier.startsWith(MOZ_SRC)) {
    const file = path.join(root, "src", specifier.slice(MOZ_SRC.length));
    return { url: pathToFileURL(file).href, shortCircuit: true, format: "module" };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith(".sys.mjs")) {
    return next(url, { ...context, format: "module" });
  }
  return next(url, context);
}
