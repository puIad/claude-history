// Opens imported claude.ai conversations in the real app against a test archive.
// usage: node scripts/check-import.mjs <testArchiveDir> <outDir>
import { createRequire } from "node:module";
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const pw = require(join(homedir(), "AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core"));
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [archive, out] = process.argv.slice(2);
try { execSync("taskkill /IM claude-history.exe /F", { stdio: "ignore" }); } catch {}
spawn(join(root, "bin", "claude-history.exe"), [], {
  env: { ...process.env, CLAUDE_HISTORY_ARCHIVE: archive, CLAUDE_HISTORY_NO_AUTOSYNC: "1", WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9334" },
  detached: true, stdio: "ignore",
}).unref();
let b;
for (let i = 0; i < 40 && !b; i++) { await new Promise((r) => setTimeout(r, 500)); b = await pw.chromium.connectOverCDP("http://127.0.0.1:9334").catch(() => null); }
const page = b.contexts()[0].pages()[0];
await page.emulateMedia({ colorScheme: null });
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };
await page.waitForSelector("#side-list .srow", { timeout: 15000 });
ok((await page.textContent("#side-list")).includes("claude.ai"), "no claude.ai group");
await page.locator("#side-list .srow", { hasText: "weekly MAJOR content plan" }).click();
await page.waitForSelector(".thread-inner .turn", { timeout: 10000 });
await page.waitForTimeout(600);
const t = await page.textContent("#thread");
ok(t.includes("BRIEF-2.md"), "attachment name missing");
ok(t.includes("Behind the scenes reel"), "table missing");
ok(t.includes("Saturday at 21:00"), "second reply missing");
ok(await page.locator(".steps-h").count() > 0, "tool activity row missing");
await page.locator(".steps-h").first().click();
await page.locator(".steps.open .step-h").first().click();
await page.waitForTimeout(300);
ok((await page.textContent("#thread")).includes("Evenings 19:00-22:00"), "tool result missing");
await page.screenshot({ path: join(out, "import-1.png") });
await page.keyboard.press("Control+k"); await page.keyboard.type("integral"); await page.waitForTimeout(600);
ok(await page.locator(".presult").count() > 0, "search did not find imported text");
await page.keyboard.press("Enter");
await page.waitForSelector(".katex", { timeout: 10000 }).catch(() => fails.push("math not rendered"));
await page.screenshot({ path: join(out, "import-2.png") });
console.log(fails.length ? "FAIL: " + fails.join("; ") : "PASS: imported conversations open, render and search in the real app");
await b.close();
execSync("taskkill /IM claude-history.exe /F", { stdio: "ignore" });
