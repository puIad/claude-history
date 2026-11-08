// Markdown -> sanitised HTML with highlighted code and KaTeX math, styled like the app.
import { Marked } from "../vendor/marked.esm.js";
import DOMPurify from "../vendor/purify.es.mjs";
import hljs from "../vendor/highlight/highlight.min.js";
import powershell from "../vendor/highlight/powershell.min.js";
import latex from "../vendor/highlight/latex.min.js";
import dockerfile from "../vendor/highlight/dockerfile.min.js";

hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("latex", latex);
hljs.registerLanguage("dockerfile", dockerfile);
import katex from "../vendor/katex/katex.mjs";
import { esc } from "./format.js";
import { icon } from "./icons.js";

function renderMath(tex, display) {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore", output: "html" });
  } catch {
    return `<code>${esc(tex)}</code>`;
  }
}

const mathBlock = {
  name: "mathBlock",
  level: "block",
  start(src) {
    const m = src.match(/\$\$|\\\[/);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$/.exec(src) || /^\\\[([\s\S]+?)\\\]/.exec(src);
    if (m) return { type: "mathBlock", raw: m[0], text: m[1].trim() };
  },
  renderer(tok) {
    return `<div class="math-block">${renderMath(tok.text, true)}</div>`;
  },
};

const mathInline = {
  name: "mathInline",
  level: "inline",
  start(src) {
    const m = src.match(/\$(?!\s)|\\\(/);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    // $x$ but not prices like "$5 and $10": require non-space inside the delimiters and no digit right after the closer
    let m = /^\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (m && /[a-zA-Z\\^_{}=]/.test(m[1])) return { type: "mathInline", raw: m[0], text: m[1] };
    m = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (m) return { type: "mathInline", raw: m[0], text: m[1] };
  },
  renderer(tok) {
    return renderMath(tok.text, false);
  },
};

const LANG_NAMES = { js: "javascript", ts: "typescript", py: "python", rs: "rust", sh: "bash", ps1: "powershell", yml: "yaml", md: "markdown" };

export function codeBlockHtml(text, lang) {
  const l = (lang || "").trim().split(/\s+/)[0].toLowerCase();
  const name = LANG_NAMES[l] || l;
  let body;
  try {
    body = name && hljs.getLanguage(name) ? hljs.highlight(text, { language: name, ignoreIllegals: true }).value : esc(text);
  } catch {
    body = esc(text);
  }
  return `<div class="codeblock"><div class="cb-h"><span>${esc(l || "text")}</span><button class="ibtn" data-copy title="Copy">${icon("copy", "sm")}</button></div><pre><code class="hljs">${body}</code></pre></div>`;
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  extensions: [mathBlock, mathInline],
  renderer: {
    code(tok) {
      return codeBlockHtml(tok.text, tok.lang);
    },
    link(tok) {
      const text = this.parser.parseInline(tok.tokens);
      return `<a data-href="${esc(tok.href)}" title="${esc(tok.title || tok.href)}">${text}</a>`;
    },
  },
});

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName === "data-href" || data.attrName === "data-copy") data.forceKeepAttr = true;
});

const cache = new Map();

export function md(src) {
  if (!src) return "";
  if (cache.has(src)) return cache.get(src);
  let html;
  try {
    html = marked.parse(src);
  } catch {
    html = `<p>${esc(src)}</p>`;
  }
  html = DOMPurify.sanitize(html, {
    ADD_TAGS: ["semantics", "annotation", "mrow", "mi", "mo", "mn", "msup", "msub", "mfrac", "math"],
    ADD_ATTR: ["data-href", "data-copy", "aria-hidden", "encoding"],
    FORBID_TAGS: ["style", "script", "iframe", "form", "input"],
  });
  if (cache.size > 4000) cache.clear();
  cache.set(src, html);
  return html;
}

export function highlight(text, lang) {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {}
  return esc(text);
}
