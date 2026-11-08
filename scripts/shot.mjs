// Screenshot the UI in headless Chrome for Testing against `--dump` data.
// usage: node scripts/shot.mjs <out.png> [sessionKey|usage] [width] [height] [actions]
// actions: comma list of "click|<css>" / "wait|<ms>" / "scroll|<css>|<px|top>" / "into|<css>" (scroll into view) / "key|<key>" / "type|<text>" run before the shot.
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const require = createRequire(import.meta.url);
const pw = require(join(homedir(), "AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core"));
const msp = join(homedir(), "AppData/Local/ms-playwright");
const shell = readdirSync(msp).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
const executablePath = join(msp, shell, "chrome-headless-shell-win64", "chrome-headless-shell.exe");

const [out = "shot.png", open = "", w = "1646", h = "1000", actions = ""] = process.argv.slice(2);
const port = process.env.PORT || "8765";
const browser = await pw.chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1, colorScheme: process.env.SCHEME || "dark" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const dataDir = process.env.DATA || "archive/.dev";
await page.goto(`http://127.0.0.1:${port}/ui/index.html?data=../${dataDir}/${open ? "&open=" + encodeURIComponent(open) : ""}`);
await page.waitForTimeout(2800); // the browser stand-in toasts "Archiving runs in the app" for ~1.8s
for (const a of actions.split(",").filter(Boolean)) {
  const [kind, sel, arg] = a.split("|");
  if (kind === "click") await page.click(sel).catch((e) => errors.push("click " + sel + ": " + e.message.split("\n")[0]));
  if (kind === "wait") await page.waitForTimeout(Number(sel));
  if (kind === "scroll") await page.evaluate(([s, px]) => { const el = document.querySelector(s); if (el) el.scrollTop = px === "top" ? 0 : Number(px); }, [sel, arg]);
  if (kind === "into") await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.scrollIntoView({ block: "start" }); }, sel);
  if (kind === "key") await page.keyboard.press(sel);
  if (kind === "type") await page.keyboard.type(sel);
}
await page.waitForTimeout(400);
await page.screenshot({ path: out });
if (errors.length) console.log("ERRORS:\n" + errors.join("\n"));
await browser.close();
