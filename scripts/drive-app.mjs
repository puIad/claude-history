// End-to-end check of the real app: launches bin\claude-history.exe with WebView2
// remote debugging on, attaches Playwright over CDP and clicks through the UI.
// Every call goes through the real Rust backend. Screenshots land in <outDir>.
// usage: node scripts/drive-app.mjs <outDir>
import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pw = require(join(homedir(), "AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core"));
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] || join(root, "archive", ".dev", "drive");
mkdirSync(out, { recursive: true });

try { execSync("taskkill /IM claude-history.exe /F", { stdio: "ignore" }); } catch {}
const port = 9333;
const app = spawn(join(root, "bin", "claude-history.exe"), [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  detached: true, stdio: "ignore",
});
app.unref();

let browser;
for (let i = 0; i < 40 && !browser; i++) {
  await new Promise((r) => setTimeout(r, 500));
  browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
}
if (!browser) { console.error("could not attach to the app's webview"); process.exit(1); }
let page;
for (let i = 0; i < 20 && !page; i++) {
  page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("index.html") || p.url().startsWith("http://tauri.localhost"));
  if (!page) await new Promise((r) => setTimeout(r, 300));
}
// Playwright emulates a light colour scheme on attach; let the app see the real OS setting.
await page.emulateMedia({ colorScheme: null }).catch(() => {});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) {
    results.push(["FAIL", name, e.message.split("\n")[0]]);
    await page.screenshot({ path: join(out, "fail-" + name.replace(/\W+/g, "-") + ".png") }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }
};
const shot = (n) => page.screenshot({ path: join(out, n + ".png") });
const wait = (ms) => page.waitForTimeout(ms);

await page.waitForSelector("#side-list .srow", { timeout: 20000 });
await check("sidebar lists sessions from the backend", async () => {
  const n = await page.locator("#side-list .srow").count();
  if (n < 10) throw new Error(`only ${n} rows`);
});
await check("open a session from the sidebar", async () => {
  await page.locator("#side-list .srow", { hasText: "Machine Electriques 3" }).first().click();
  await page.waitForSelector(".thread-inner .turn", { timeout: 15000 });
  await wait(800);
  const t = await page.textContent("#title-text");
  if (!t.includes("Machine Electriques")) throw new Error("title is " + t);
  await shot("01-session");
});
await check("details panel shows context and cost", async () => {
  const body = await page.textContent("#details-body");
  if (!/% used/.test(body) || !body.includes("$9.55")) throw new Error("missing context or cost");
});
await check("expand an activity group and a step", async () => {
  await page.evaluate(() => (document.getElementById("thread").scrollTop = 0));
  await wait(1500);
  await page.locator(".steps-h").first().click();
  await page.locator(".steps.open .step-h").first().click();
  await page.waitForSelector(".step.open .io pre", { timeout: 5000 });
  await shot("02-steps");
});
await check("hovering an activity thumbnail previews the image", async () => {
  const thumb = page.locator(".thumbs img").first();
  await thumb.scrollIntoViewIfNeeded();
  await thumb.hover();
  await page.waitForSelector("#peek.show", { timeout: 3000 });
  await shot("02b-peek");
  await page.mouse.move(5, 500);
});
await check("status strip jumps to the cost section", async () => {
  await page.click('[data-jump="d-cost"]');
  await wait(700);
  const top = await page.evaluate(() => document.getElementById("d-cost").getBoundingClientRect().top);
  if (top > 300) throw new Error("cost section not scrolled into view: " + top);
});
await check("title menu opens", async () => {
  await page.click("#title-btn");
  await page.waitForSelector("#menu.show", { timeout: 3000 });
  await shot("03-title-menu");
  await page.keyboard.press("Escape");
});
await check("search palette finds by conversation text", async () => {
  await page.keyboard.press("Control+k");
  await page.waitForSelector("#palette.show");
  await page.keyboard.type("asynchronous motor");
  await wait(900);
  const n = await page.locator(".presult").count();
  if (!n) throw new Error("no results");
  await shot("04-search");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".thread-inner .turn", { timeout: 15000 });
});
await check("find in conversation highlights matches", async () => {
  await page.keyboard.press("Control+f");
  await page.keyboard.type("interro");
  await wait(600);
  const c = await page.textContent("#find-count");
  if (!/of \d+/.test(c)) throw new Error("count is " + c);
  await shot("05-find");
  await page.keyboard.press("Escape");
});
await check("agent transcript opens", async () => {
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Share tags with no dates");
  await wait(500);
  await page.keyboard.press("Enter");
  await page.waitForSelector("#details-body [data-subagent]", { timeout: 15000 });
  await page.click("#details-body [data-subagent]");
  await page.waitForSelector("#sheet.show .turn", { timeout: 10000 });
  await shot("06-agent");
  await page.click("#sheet-x");
});
await check("Cowork cloud session shows its metadata", async () => {
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Cowork session in MAJOR");
  await wait(500);
  await page.keyboard.press("Enter");
  await page.waitForSelector("text=This Cowork session ran in the cloud", { timeout: 10000 });
  await shot("07-cowork");
});
await check("usage page renders the chart", async () => {
  await page.click("#btn-usage");
  await page.waitForSelector(".chart svg rect", { timeout: 15000 });
  await wait(500);
  await shot("08-usage");
});
await check("plan usage limits show the desktop's recorded values", async () => {
  await page.waitForSelector("#plan-panel .plan-row", { timeout: 5000 });
  const txt = await page.textContent("#plan-panel");
  if (!/Current session/.test(txt) || !/All models/.test(txt) || !/% used/.test(txt)) throw new Error("rows missing");
  const tabs = await page.locator("[data-plan-acct]").count();
  if (tabs > 1) { await page.click('[data-plan-acct="1"]'); await wait(200); await page.click('[data-plan-acct="0"]'); }
  await page.click('[data-plan-days="7"]');
  await wait(200);
  await page.locator("#plan-panel").screenshot({ path: join(out, "08b-plan.png") });
});
await check("settings sheet and theme switch", async () => {
  await page.click("#btn-settings");
  await page.waitForSelector("#sheet.show [data-theme-set]");
  await page.click('[data-theme-set="light"]');
  await wait(300);
  await shot("09-settings-light");
  await page.click('[data-theme-set="system"]');
  await page.click("#sheet-x");
});
await check("sidebar filters and folding rows", async () => {
  await page.click('[data-filter="archived"]');
  await wait(300);
  const n = await page.locator("#side-list .srow.archived").count();
  if (!n) throw new Error("no archived rows under Archived");
  await page.click('[data-filter="all"]');
  await wait(200);
  const term = page.locator("[data-terminal]").first();
  if (await term.count()) { await term.click(); await wait(200); }
  await shot("10-sidebar");
});
await check("back button returns to the previous view", async () => {
  await page.click("#btn-back");
  await wait(1200);
  const t = await page.textContent("#title-text");
  if (!t) throw new Error("no title after back");
});
await check("sync now runs and reindexes", async () => {
  await page.click("#btn-sync");
  await page.waitForFunction(() => /Archived (just now|\d+ min)/.test(document.getElementById("sync-strip").textContent), null, { timeout: 60000 });
});
await check("details panel hides and window controls float", async () => {
  await page.click("#btn-details");
  await wait(400);
  const shown = await page.isVisible("#float-ctl");
  if (!shown) throw new Error("floating controls not shown");
  await shot("11-no-details");
  await page.click("#f-details");
});

for (const r of results) console.log(r.join("  "));
if (errors.length) console.log("CONSOLE ERRORS:\n" + errors.join("\n"));
await browser.close().catch(() => {});
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
