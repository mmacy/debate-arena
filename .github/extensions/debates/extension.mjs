// Bootstrapper. Copilot CLI loads this file. We can't statically import npm
// deps here because they may not be installed yet on a fresh checkout — so
// `bootstrap` runs `npm install` if needed, then we dynamically import main.
import { bootstrap } from "./lib/copilot-webview.js";

await bootstrap(import.meta.dirname);
await import("./main.mjs");
