// Writes invented sessions in the same JSON shape `claude-history --dump` produces, so the UI
// can be screenshotted without touching a real archive. Nothing here comes from anyone's history.
// usage: node scripts/demo-data.mjs [outDir]      (default: archive/.demo, which is git-ignored)
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] || "archive/.demo";
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "sessions"), { recursive: true });
mkdirSync(join(out, "subagents"), { recursive: true });

const NOW = Date.now();
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const HOME = "C:\\Users\\sam";
const uuid = (n) => `${String(n).padStart(8, "0")}-aaaa-4bbb-8ccc-${String(n).padStart(12, "0")}`;
let uid = 1;

// ---------------------------------------------------------------- item builders
const user = (text, ts) => ({ kind: "user", origin: "typed", text, images: [], ts, uuid: uuid(uid++) });
const assistant = (blocks, ts, model = "claude-opus-5-5") => ({ kind: "assistant", model, blocks, ts, uuid: uuid(uid++) });
const text = (t) => ({ type: "text", text: t });
const thinking = (t, ms = 4200) => ({ type: "thinking", text: t, ms });
let tid = 1;
const tool = (name, input, result, extra = {}) => ({
  type: "tool", id: `toolu_demo${String(tid++).padStart(4, "0")}`, name, input, server: false,
  result: result == null ? null : { error: false, full_len: String(result).length, images: [], persisted: false, text: String(result), truncated: false, ...extra },
});

// ---------------------------------------------------------------- the main session
const REPO = `${HOME}\\code\\recipe-planner`;
const t0 = NOW - 52 * MIN;
let ts = t0;
const step = (s = 20) => (ts += s * 1000);

const weekJs = `import { recipes } from "../data/recipes.js";
import { sumCalories } from "./nutrition.js";

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A week is seven arrays of recipe ids, one per day. */
export function emptyWeek() {
  return DAYS.map(() => []);
}

export function addToDay(week, dayIndex, recipeId) {
  const next = week.map((d) => d.slice());
  next[dayIndex].push(recipeId);
  return next;
}

export function removeFromDay(week, dayIndex, slot) {
  const next = week.map((d) => d.slice());
  next[dayIndex].splice(slot, 1);
  return next;
}

export function dayTotals(week) {
  return week.map((ids) => sumCalories(ids.map((id) => recipes[id])));
}
`;

const mainItems = [];
mainItems.push(user("Add a weekly meal planner view to the recipe app. Seven columns, drag a recipe onto a day, and show the calorie total for each day.", ts));
step(8);
mainItems.push(assistant([
  text("I'll start by looking at how the existing views are wired up and where recipe data lives, then build the planner on top of that."),
  tool("Grep", { pattern: "sumCalories|calories", path: `${REPO}\\src` }, `src/planner/nutrition.js:3:export function sumCalories(list) {\nsrc/data/recipes.js:12:    calories: 540,\nsrc/data/recipes.js:27:    calories: 410,\nsrc/data/recipes.js:41:    calories: 365,\nsrc/views/RecipeCard.js:18:  <span class="kcal">\${r.calories} kcal</span>`),
  tool("Read", { file_path: `${REPO}\\src\\data\\recipes.js` }, `     1\texport const recipes = {\n     2\t  lentil_soup: {\n     3\t    name: "Red lentil soup",\n     4\t    servings: 4,\n     5\t    calories: 410,\n     6\t    minutes: 35,\n     7\t  },\n     8\t  shakshuka: {\n     9\t    name: "Shakshuka",\n    10\t    servings: 2,\n    11\t    calories: 365,\n    12\t    minutes: 25,\n    13\t  },\n    14\t};`),
  tool("Read", { file_path: `${REPO}\\src\\views\\RecipeCard.js` }, `     1\timport { esc } from "../util.js";\n     2\t\n     3\texport function RecipeCard(id, r) {\n     4\t  return \`<article class="card" draggable="true" data-id="\${id}">\n     5\t    <h3>\${esc(r.name)}</h3>\n     6\t    <span class="kcal">\${r.calories} kcal</span>\n     7\t  </article>\`;\n     8\t}`),
], step(14)));
step(10);
mainItems.push(assistant([
  text("Cards are already `draggable`, so the planner only needs drop targets and a pure state module for the week. I'll keep the state logic separate from the DOM so it's easy to test."),
  tool("Write", { file_path: `${REPO}\\src\\planner\\week.js`, content: weekJs }, `File created successfully at: ${REPO}\\src\\planner\\week.js`),
], step(30)));
step(6);
mainItems.push(assistant([
  tool("Edit", { file_path: `${REPO}\\src\\planner\\nutrition.js`, old_string: "return list.reduce((n, r) => n + r.calories, 0);", new_string: "return list.reduce((n, r) => n + (r ? r.calories : 0), 0);" },
    "The file has been updated.",
    { patch: [{ oldStart: 1, oldLines: 6, newStart: 1, newLines: 6, lines: [
      " // Calories for a list of recipes.",
      " // Unknown ids resolve to undefined; they count as zero.",
      " export function sumCalories(list) {",
      "-  return list.reduce((n, r) => n + r.calories, 0);",
      "+  return list.reduce((n, r) => n + (r ? r.calories : 0), 0);",
      " }",
    ] }] }),
  tool("Edit", { file_path: `${REPO}\\src\\views\\Planner.js`, old_string: "el.addEventListener(\"dragover\", (e) => e.preventDefault());", new_string: "el.addEventListener(\"dragover\", (e) => { e.preventDefault(); col.classList.add(\"over\"); });" },
    "The file has been updated.",
    { patch: [{ oldStart: 24, oldLines: 7, newStart: 24, newLines: 8, lines: [
      "   for (const [i, col] of columns.entries()) {",
      "-    col.addEventListener(\"dragover\", (e) => e.preventDefault());",
      "+    col.addEventListener(\"dragover\", (e) => {",
      "+      e.preventDefault();",
      "+      col.classList.add(\"over\");",
      "+    });",
      "     col.addEventListener(\"drop\", (e) => {",
      "       const id = e.dataTransfer.getData(\"text/plain\");",
      "       state.week = addToDay(state.week, i, id);",
    ] }] }),
], step(40)));
step(5);
mainItems.push(assistant([
  tool("Bash", { command: "cd \"C:/Users/sam/code/recipe-planner\" && node --test", description: "Run the test suite" },
    "✔ emptyWeek returns seven empty days (0.6ms)\n✔ addToDay does not mutate the old week (0.3ms)\n✔ removeFromDay drops one slot (0.2ms)\n✔ dayTotals sums calories per day (0.4ms)\n✔ unknown recipe ids count as zero (0.2ms)\nℹ tests 5\nℹ pass 5\nℹ fail 0\nℹ duration_ms 71"),
  tool("Bash", { command: "cd \"C:/Users/sam/code/recipe-planner\" && git diff --stat", description: "Show what changed" },
    " src/planner/nutrition.js |  2 +-\n src/planner/week.js      | 29 +++++++++++++++++++++++++++++\n src/views/Planner.js     | 61 +++++++++++++++++++++++++++++++++++++++++++++\n test/week.test.js        | 36 ++++++++++++++++++++++++++++++++++++\n 4 files changed, 127 insertions(+), 1 deletion(-)"),
  text("The planner is in. Here is what a week looks like with a few recipes dropped on it:\n\n| Day | Recipes | Calories |\n|---|---|---:|\n| Mon | Red lentil soup, Flatbread | 690 |\n| Tue | Shakshuka | 365 |\n| Wed | Red lentil soup | 410 |\n| Thu | Empty | 0 |\n\nThe day total is a plain sum, $\\text{kcal}_{day} = \\sum_{i} \\text{kcal}_i$, so a recipe dropped twice counts twice. State lives in `src/planner/week.js` and never touches the DOM:\n\n```js\nimport { emptyWeek, addToDay, dayTotals } from \"./planner/week.js\";\n\nlet week = emptyWeek();\nweek = addToDay(week, 0, \"lentil_soup\");\nconsole.log(dayTotals(week)[0]); // 410\n```\n\nThings I did not do: persisting the week between visits, and per-serving calories. Say the word if you want either."),
  tool("mcp__ccd_turn__update_plan", { items: [
    { content: "Read recipe data and cards", status: "completed" },
    { content: "Add week state module", status: "completed" },
    { content: "Wire drop targets in the Planner view", status: "completed" },
    { content: "Test and total calories per day", status: "completed" },
  ], scope: "first_task" }, "Plan shown (4 steps)."),
  tool("mcp__ccd_turn__wrap_up", {
    recap: "The weekly planner view is working: seven day columns accept dropped recipes and each shows its calorie total. All five new tests pass. The week is not saved between visits yet.",
    ask: "Save the planned week between visits?",
    actions: [{ label: "Yes, save it" }, { label: "Not now" }],
  }, "Wrap-up box shown."),
], step(55)));
step(40);
mainItems.push(user("Nice. Can the planner remember the week between visits?", ts));
step(6);
mainItems.push(assistant([
  text("Yes. I'll store the week in `localStorage` under one key, load it on start, and fall back to an empty week if the stored value is missing or malformed."),
  tool("Edit", { file_path: `${REPO}\\src\\planner\\store.js`, old_string: "", new_string: "" },
    "The file has been updated.",
    { patch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 14, lines: [
      " import { emptyWeek, DAYS } from \"./week.js\";",
      " ",
      "+const KEY = \"recipe-planner.week.v1\";",
      "+",
      "+export function loadWeek() {",
      "+  try {",
      "+    const raw = JSON.parse(localStorage.getItem(KEY));",
      "+    if (Array.isArray(raw) && raw.length === DAYS.length) return raw;",
      "+  } catch {}",
      "+  return emptyWeek();",
      "+}",
      "+",
      "+export const saveWeek = (week) => localStorage.setItem(KEY, JSON.stringify(week));",
    ] }] }),
  tool("Bash", { command: "cd \"C:/Users/sam/code/recipe-planner\" && node --test", description: "Run the tests again" },
    "ℹ tests 8\nℹ pass 8\nℹ fail 0"),
  text("Done. Reloading the page now brings back the same week, and a corrupted value just resets to an empty one. Eight tests pass."),
], step(70)));

const mainDetails = {
  changes: { added: 156, removed: 3 },
  connectors: [{ name: "GitHub", tools: 41, url: "https://example.com/mcp" }, { name: "Context7", tools: 2, url: "https://example.com/mcp" }, { name: "Playwright", tools: 24, url: "https://example.com/mcp" }],
  context: {
    categories: [
      { key: "messages", name: "Messages", tokens: 38200 },
      { key: "system_tools", name: "System tools", tokens: 11400 },
      { key: "system_prompt", name: "System prompt", tokens: 6100 },
      { key: "mcp_tools", name: "MCP tools", tokens: 5200 },
      { key: "skills", name: "Skills", tokens: 2800 },
      { key: "memory", name: "Memory files", tokens: 1900 },
      { key: "agents", name: "Custom agents", tokens: 800 },
      { key: "autocompact", name: "Autocompact buffer", tokens: 33000 },
      { key: "free", name: "Free space", tokens: 100600 },
    ],
    deferred: { mcp: 61, system: 24 },
    lists: {
      agents: ["code-reviewer", "test-runner"],
      mcp_tools: ["mcp__github__create_pull_request", "mcp__github__list_issues", "mcp__context7__query-docs"],
      memory_files: [{ path: `${HOME}\\.claude\\CLAUDE.md`, tokens: 900, type: "User" }, { path: `${REPO}\\CLAUDE.md`, tokens: 1000, type: "Project" }],
      skills: ["frontend-design", "tdd", "code-review", "humanizer"],
    },
    model: "claude-opus-5-5",
    total: 66400,
    window: 200000,
    usage: { cache_read: 410000, cache_write: 52000, input: 3400, output: 11800 },
  },
  cost: {
    api_ms: 168000, tool_ms: 14000, wall_ms: 52 * MIN, estimated: false, estimate_total: 2.31, total: 2.14,
    by_model: [{ model: "Opus 5.5", cost: 2.14, input: 3400, output: 11800, cache_read: 410000, cache_write: 52000, messages: 14 }],
  },
  env: {
    branch: "feature/weekly-planner", cwd: REPO, group: "Recipe Planner", group_cwd: REPO, permission_mode: "auto",
    profile: "Claude", remote_control: false, source: "desktop", versions: ["2.1.317"], worktree: "",
    environment: { isGitRepo: true, isWorktree: false, platform: "win32", workingDirectory: REPO },
  },
  missing: [],
  outputs: {
    artifacts: [],
    prs: [],
    files: [
      { count: 3, kind: "edited", path: `${REPO}\\src\\views\\Planner.js` },
      { count: 2, kind: "edited", path: `${REPO}\\src\\planner\\store.js` },
      { count: 1, kind: "created", path: `${REPO}\\src\\planner\\week.js` },
      { count: 1, kind: "created", path: `${REPO}\\test\\week.test.js` },
      { count: 1, kind: "edited", path: `${REPO}\\src\\planner\\nutrition.js` },
    ],
  },
  plan: [
    { content: "Read recipe data and cards", status: "completed" },
    { content: "Add week state module", status: "completed" },
    { content: "Wire drop targets in the Planner view", status: "completed" },
    { content: "Test and total calories per day", status: "completed" },
  ],
  subagents: [],
  summary: {},
  time: { first: t0, last: ts },
  tools: { Bash: 3, Edit: 3, Grep: 1, Read: 2, Write: 1 },
};

// ---------------------------------------------------------------- the question session
const q0 = NOW - 5 * HOUR;
const GARDEN = `${HOME}\\code\\garden-journal`;
const questionItems = [
  user("Plan watering reminders for the plants in my garden journal app.", q0),
  assistant([
    text("Before I wire reminders, two choices change the design. Plants differ a lot in how often they need water, and the app has no notification permission yet."),
    tool("AskUserQuestion", { questions: [
      { header: "Schedule", question: "How should reminder timing be set?", multiSelect: false, options: [
        { label: "Per plant (Recommended)", description: "Each plant stores its own interval, such as every 3 days or every 2 weeks." },
        { label: "Per bed", description: "One interval for every plant in a bed. Simpler, less accurate." },
      ] },
      { header: "Delivery", question: "Where should reminders appear?", multiSelect: false, options: [
        { label: "In-app list", description: "A Due today list on the home screen. No permissions needed." },
        { label: "Browser notifications", description: "Needs the user to grant permission and the tab to be open." },
      ] },
    ] }, "User has answered your questions: \"How should reminder timing be set?\"=\"Per plant (Recommended)\", \"Where should reminders appear?\"=\"In-app list\"."),
  ], q0 + 15e3),
  assistant([
    text("Per plant, shown in a Due today list. I'll add an `intervalDays` field to each plant and compute the next watering from the last one."),
    tool("Read", { file_path: `${GARDEN}\\src\\plants.js` }, "     1\texport const plants = [\n     2\t  { id: 1, name: \"Basil\", bed: \"Herbs\", lastWatered: \"2026-11-05\" },\n     3\t  { id: 2, name: \"Tomato\", bed: \"Raised bed\", lastWatered: \"2026-11-06\" },\n     4\t];"),
    tool("Edit", { file_path: `${GARDEN}\\src\\plants.js`, old_string: "", new_string: "" }, "The file has been updated.", { patch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [
      " export const plants = [",
      "-  { id: 1, name: \"Basil\", bed: \"Herbs\", lastWatered: \"2026-11-05\" },",
      "-  { id: 2, name: \"Tomato\", bed: \"Raised bed\", lastWatered: \"2026-11-06\" },",
      "+  { id: 1, name: \"Basil\", bed: \"Herbs\", lastWatered: \"2026-11-05\", intervalDays: 2 },",
      "+  { id: 2, name: \"Tomato\", bed: \"Raised bed\", lastWatered: \"2026-11-06\", intervalDays: 3 },",
      " ];",
    ] }] }),
    text("Each plant now carries its own interval. The home screen's Due today list is next."),
  ], q0 + 90e3),
];

// ---------------------------------------------------------------- small filler sessions
function smallSession(prompt, answer, t, cwd, extra = []) {
  return [user(prompt, t), assistant([...extra, text(answer)], t + 40e3)];
}

// ---------------------------------------------------------------- session list
const base = (o) => ({
  archived: false, artifacts: 0, branch: "", cli_id: "", cli_ids: [], context_tokens: 0, context_window: 200000, cost_estimated: false,
  cost_usd: 0, created_ms: 0, cwd: "", effort: "medium", first_prompt: "", group: "", group_cwd: "", has_transcript: true, key: "",
  lines_added: 0, lines_removed: 0, model: "claude-opus-5-5", model_name: "Opus 5.5", parent_key: "", permission_mode: "auto",
  profile: "Claude", prompts: 1, prs: [], scheduled: false, side: false, source: "desktop", starred: false, summary: "", title: "",
  tokens: 0, tool_calls: 0, updated_ms: 0, worktree: "", ...o,
});

const G = {
  recipe: { group: "Recipe Planner", group_cwd: REPO, cwd: REPO },
  garden: { group: "Garden Journal", group_cwd: GARDEN, cwd: GARDEN },
  weather: { group: "Weather Dashboard", group_cwd: `${HOME}\\code\\weather-dashboard`, cwd: `${HOME}\\code\\weather-dashboard` },
  quest: { group: "Pixel Quest", group_cwd: `${HOME}\\code\\pixel-quest`, cwd: `${HOME}\\code\\pixel-quest` },
};

let n = 1;
const key = () => `local_${uuid(1000 + n++)}`;
const sessions = [];
const bodies = new Map();
const add = (meta, items, details) => {
  const k = meta.key || key();
  const s = base({ ...meta, key: k, cli_id: uuid(5000 + n), cli_ids: [uuid(5000 + n)], first_prompt: items.find((i) => i.kind === "user")?.text || "", created_ms: items[0]?.ts || meta.updated_ms, prompts: items.filter((i) => i.kind === "user").length });
  sessions.push(s);
  bodies.set(k, { session: s, items, details });
  return s;
};

// Each session gets its own context breakdown, scaled from how much work it did.
const contextFor = (s) => {
  const cats = mainDetails.context.categories.map((c) => (c.key === "messages" ? { ...c, tokens: Math.round(8000 + s.tokens * 0.045) } : c));
  const used = cats.filter((c) => !["free", "autocompact"].includes(c.key)).reduce((a, c) => a + c.tokens, 0);
  const auto = cats.find((c) => c.key === "autocompact").tokens;
  return { ...mainDetails.context, categories: cats.map((c) => (c.key === "free" ? { ...c, tokens: 200000 - used - auto } : c)), total: used };
};

const detailsFor = (s, over = {}) => ({
  ...mainDetails,
  context: contextFor(s),
  changes: { added: s.lines_added, removed: s.lines_removed },
  cost: { ...mainDetails.cost, total: s.cost_usd, estimate_total: s.cost_usd, wall_ms: 24 * MIN, by_model: [{ model: s.model_name, cost: s.cost_usd, input: 1200, output: 6400, cache_read: 180000, cache_write: 24000, messages: 8 }] },
  env: { ...mainDetails.env, group: s.group, group_cwd: s.group_cwd, cwd: s.cwd, branch: s.branch },
  outputs: { artifacts: [], prs: [], files: [] },
  plan: [],
  time: { first: s.created_ms, last: s.updated_ms },
  ...over,
});

const main = add({ ...G.recipe, title: "Add weekly meal planner view", updated_ms: ts, cost_usd: 2.14, lines_added: 156, lines_removed: 3, tokens: 477000, tool_calls: 10, branch: "feature/weekly-planner", starred: true, summary: "Planner view works; week saves to localStorage.", context_tokens: 66400, effort: "high" }, mainItems, mainDetails);
const ingr = add({ ...G.recipe, title: "Fix ingredient unit conversion", updated_ms: NOW - 3 * HOUR, cost_usd: 0.92, lines_added: 41, lines_removed: 12, tokens: 210000, tool_calls: 7, branch: "fix/units" },
  smallSession("Cups to millilitres comes out wrong for half cups. Find out why.", "Half a cup was converted with `Math.round(cups * 236.588)` before halving, which rounds twice. Convert once, then round: `Math.round(cups * 236.588)` on the final amount. Fixed in `src/units.js`, with a test for 0.5, 0.25 and 1.5 cups.", NOW - 3 * HOUR - 24 * MIN), null);
add({ ...G.recipe, title: "Check rounding rules for tablespoons", side: true, parent_key: ingr.key, updated_ms: NOW - 3 * HOUR - 5 * MIN, cost_usd: 0.11, tokens: 18000, tool_calls: 1 },
  smallSession("What do other recipe sites do when a tablespoon amount is below 1/8?", "Most round to the nearest 1/8 and switch to \"a pinch\" under 1/16. I'd keep the exact value in the data and only round when displaying.", NOW - 3 * HOUR - 8 * MIN), null);
add({ ...G.recipe, title: "Write tests for the shopping list", archived: true, updated_ms: NOW - 6 * DAY, cost_usd: 1.37, lines_added: 88, tokens: 320000, tool_calls: 12 },
  smallSession("Add tests for merging duplicate ingredients on the shopping list.", "Added eight cases: same unit, mixed units, case differences, and a missing quantity. All pass.", NOW - 6 * DAY), null);
add({ ...G.recipe, title: "Rename Card component props", source: "cli", updated_ms: NOW - 2 * DAY, cost_usd: 0.31, tokens: 70000, tool_calls: 4 },
  smallSession("rename `r` to `recipe` in RecipeCard", "Renamed in the component and its two call sites.", NOW - 2 * DAY), null);

const qs = add({ ...G.garden, title: "Plan watering reminders", updated_ms: NOW - 5 * HOUR + 90e3, cost_usd: 0.58, lines_added: 12, lines_removed: 4, tokens: 120000, tool_calls: 2, branch: "main" }, questionItems, null);
add({ ...G.garden, title: "Set up the plant database schema", updated_ms: NOW - 1 * DAY - 2 * HOUR, cost_usd: 1.04, lines_added: 73, tokens: 260000, tool_calls: 9, branch: "main" },
  smallSession("Design a small SQLite schema for plants, beds and watering events.", "Three tables: `beds`, `plants` (with `bed_id` and `interval_days`), and `watering_events` (plant, timestamp). Added the migration and a seed script.", NOW - 1 * DAY - 2 * HOUR), null);
add({ ...G.garden, title: "Import last season's photos", updated_ms: NOW - 9 * DAY, archived: true, cost_usd: 0.4, tokens: 90000, tool_calls: 3 },
  smallSession("Import the photos in the old folder and link them to plants by filename.", "Linked 46 of 52 photos. The other six had no matching plant name, listed in `unmatched.txt`.", NOW - 9 * DAY), null);

add({ ...G.weather, title: "Chart the hourly forecast", updated_ms: NOW - 20 * HOUR, cost_usd: 1.66, lines_added: 134, lines_removed: 9, tokens: 390000, tool_calls: 11, branch: "feature/hourly" },
  smallSession("Add a 24-hour temperature chart under the current conditions card.", "Added an inline SVG line chart with a shaded rain-probability band. It redraws when the unit setting changes.", NOW - 20 * HOUR), null);
add({ ...G.weather, title: "Cache API responses for ten minutes", updated_ms: NOW - 2 * DAY - 4 * HOUR, cost_usd: 0.74, lines_added: 52, lines_removed: 6, tokens: 150000, tool_calls: 6 },
  smallSession("The API rate limit gets hit when I refresh a lot. Cache the responses.", "Responses are cached in memory for ten minutes, keyed by location. A manual refresh button bypasses the cache.", NOW - 2 * DAY - 4 * HOUR), null);

add({ ...G.quest, title: "Add a double jump", updated_ms: NOW - 4 * DAY, cost_usd: 1.2, lines_added: 64, lines_removed: 8, tokens: 280000, tool_calls: 8 },
  smallSession("Let the player jump a second time in the air, once per jump.", "Added a `jumpsLeft` counter that resets on landing. The second jump uses 80% of the first jump's speed so it feels distinct.", NOW - 4 * DAY), null);
add({ ...G.quest, title: "Fix the tilemap seam on slope tiles", updated_ms: NOW - 8 * DAY, archived: true, cost_usd: 0.88, tokens: 200000, tool_calls: 5 },
  smallSession("There's a one-pixel gap between slope tiles at some zoom levels.", "Tiles were drawn at fractional positions. Snapping the camera to whole pixels removes the gap.", NOW - 8 * DAY), null);

// ---------------------------------------------------------------- write sessions
for (const [k, b] of bodies) {
  const d = b.details || detailsFor(b.session);
  writeFileSync(join(out, "sessions", `${k}.json`), JSON.stringify({ session: b.session, items: b.items, details: d }));
}

// ---------------------------------------------------------------- usage
const days = [];
for (let i = 59; i >= 0; i--) {
  const d = new Date(NOW - i * DAY);
  const busy = d.getDay() === 0 || d.getDay() === 6 ? 0.35 : 1;
  const o = +(rnd() * 3.2 * busy + (rnd() > 0.82 ? 2.2 : 0.2)).toFixed(2);
  const s = +(rnd() * 1.4 * busy).toFixed(2);
  days.push({
    day: d.toISOString().slice(0, 10), cost: +(o + s).toFixed(2), messages: Math.round((o + s) * 22), tokens: Math.round((o + s) * 160000),
    by_model: { "Opus 5.5": { cost: o, tokens: Math.round(o * 150000) }, "Sonnet 5.5": { cost: s, tokens: Math.round(s * 190000) } },
  });
}
const samples = [];
for (let t = NOW - 30 * DAY; t <= NOW; t += 15 * MIN) {
  const hour = (t / HOUR) % 24;
  const day = Math.floor(t / DAY);
  const worked = hour > 8 && hour < 21 && ((day * 7919) % 10) > 2; // a few days off
  const inWindow = (t % (5 * HOUR)) / (5 * HOUR);
  const peak = 35 + ((day * 31) % 50);
  const fh = worked ? Math.round(inWindow * peak) : 0;
  const week = Math.round((((t - (NOW - 30 * DAY)) % (7 * DAY)) / (7 * DAY)) * 58 + 3);
  samples.push([t, fh, week, t > NOW - 12 * DAY ? Math.min(100, Math.round(((t - (NOW - 12 * DAY)) / (12 * DAY)) * 21)) : null]);
}
samples[samples.length - 1][1] = 41; // so the "current session" bar is not empty
const usage = {
  days,
  total_cost: +days.reduce((a, d) => a + d.cost, 0).toFixed(2),
  sessions: sessions.length,
  groups: [
    { group: "Recipe Planner", cost: 41.8, sessions: 38 }, { group: "Weather Dashboard", cost: 27.3, sessions: 22 },
    { group: "Pixel Quest", cost: 19.6, sessions: 17 }, { group: "Garden Journal", cost: 12.9, sessions: 14 },
  ],
  models: [
    { model: "Opus 5.5", cost: 84.2, input: 210000, output: 880000, cache_read: 61000000, cache_write: 5400000, messages: 1240 },
    { model: "Sonnet 5.5", cost: 14.6, input: 130000, output: 410000, cache_read: 22000000, cache_write: 1900000, messages: 860 },
    { model: "Haiku 5.5", cost: 2.8, input: 90000, output: 120000, cache_read: 3000000, cache_write: 400000, messages: 410 },
  ],
  plan: [{ profile: "Claude", org: "demo0000-0000-0000-0000-000000000000", samples }],
};
writeFileSync(join(out, "usage.json"), JSON.stringify(usage));

writeFileSync(join(out, "bootstrap.json"), JSON.stringify({
  archive: `${HOME}\\AppData\\Local\\Claude History\\archive`, built_ms: NOW, claude_home: `${HOME}\\.claude`, open: null, syncing: false,
  last_sync: { bytes_copied: 18400000, copied: 212, duration_ms: 1900, errors: [], finished_ms: NOW - 8 * MIN, preserved: 0, scanned: 3480, sources: ["Claude Code", "Claude desktop", "Cowork"] },
  profiles: [{ name: "Claude", path: `${HOME}\\AppData\\Roaming\\Claude` }],
  sessions: sessions.sort((a, b) => b.updated_ms - a.updated_ms),
}));

console.log(`wrote ${sessions.length} demo sessions to ${out}; main = ${main.key}, question = ${qs.key}`);
