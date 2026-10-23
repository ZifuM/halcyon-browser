// Lets Node load the browser's own .sys.mjs modules: maps Firefox module URLs to local files/mocks.
import { register } from "node:module";
register(new URL("./hooks.mjs", import.meta.url));
