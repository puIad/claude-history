// Copies the browser builds of the UI libraries from node_modules into ui/vendor.
// Run after `npm install` (npm run vendor). The ui/ folder has no build step.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = (p) => join(root, "node_modules", p);
const out = (p) => join(root, "ui", "vendor", p);

rmSync(out(""), { recursive: true, force: true });
mkdirSync(out(""), { recursive: true });

cpSync(nm("marked/lib/marked.esm.js"), out("marked.esm.js"));
cpSync(nm("dompurify/dist/purify.es.mjs"), out("purify.es.mjs"));
cpSync(nm("@highlightjs/cdn-assets/es/highlight.min.js"), out("highlight/highlight.min.js"));
for (const l of ["powershell", "latex", "dockerfile"]) cpSync(nm(`@highlightjs/cdn-assets/es/languages/${l}.min.js`), out(`highlight/${l}.min.js`));
cpSync(nm("katex/dist/katex.mjs"), out("katex/katex.mjs"));
cpSync(nm("katex/dist/katex.min.css"), out("katex/katex.min.css"));
cpSync(nm("katex/dist/fonts"), out("katex/fonts"), { recursive: true });
cpSync(nm("gsap/dist/gsap.min.js"), out("gsap.min.js"));
console.log("vendored into ui/vendor");
