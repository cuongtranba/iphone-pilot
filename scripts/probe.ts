#!/usr/bin/env bun
// Live probe matrix on the real phone. Writes the results for one mode into
// docs/probe-results.md (between that mode's markers), so each mode can be re-run on its own.
//
//   bun run probe -- --mode ocr                  standard cases
//   bun run probe -- --mode ocr --only covered   one case (manual cases run only with --only)
//
// Only Settings and the Home Screen are used: no purchases, no account or setting changes.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Element, type Outcome, type Pilot, type Snapshot, createPilot } from "../src/index.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { mode: { type: "string" }, only: { type: "string", multiple: true } },
});
const mode = values.mode as "ocr" | "iph";
if (mode !== "ocr" && mode !== "iph") throw new Error("--mode ocr|iph is required");

const root = join(import.meta.dir, "..");
const stateDir = join(tmpdir(), `iphone-pilot-probe-${mode}`);
const pilot = createPilot({ mode, stateDir });
const helper = join(root, "bin", "mirror-helper");
const coverBin = join(root, "bin", "probe-cover");
if (mode === "ocr" && !existsSync(coverBin)) {
  const b = Bun.spawnSync(["swiftc", "-swift-version", "5", "-O", "-o", coverBin, join(import.meta.dir, "ProbeCover.swift"), "-framework", "AppKit"]);
  if (b.exitCode !== 0) throw new Error(`building probe-cover failed: ${b.stderr.toString()}`);
}

interface Result {
  name: string;
  pass: boolean;
  ms: number;
  detail: string;
}

const texts = (s: Snapshot) => new Set(s.elements.filter((e) => e.frame.y > 44).map((e) => e.label));
const changed = (a: Snapshot, b: Snapshot) => {
  const x = texts(a), y = texts(b);
  return x.size !== y.size || [...x].some((t) => !y.has(t));
};
const brief = (o: Outcome) => JSON.stringify({ ok: o.ok, outcome: o.outcome, ...(o.screen_changed !== undefined ? { screen_changed: o.screen_changed } : {}), ...(o.error ? { code: o.error.code } : {}), ...(o.restored_front_app ? { front_restored: o.restored_front_app } : {}) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const front = () => Bun.spawnSync(["osascript", "-e", 'tell application "System Events" to name of first process whose frontmost is true']).stdout.toString().trim();

/** Polls snapshots until `pred` holds or `ms` pass; returns the last snapshot. */
async function until(pred: (s: Snapshot) => boolean, ms = 6000): Promise<Snapshot> {
  const end = Date.now() + ms;
  let s = await pilot.snapshot();
  while (!pred(s) && Date.now() < end) s = await pilot.snapshot();
  return s;
}
const has = (label: string) => (s: Snapshot) => s.elements.some((e) => e.label === label);
/** Several app names at once only happen on the Home Screen ("Settings" alone is also a page title). */
const onHome = (s: Snapshot) => ["Settings", "Camera", "Photos", "Clock", "App Store", "Maps"].filter((l) => has(l)(s)).length >= 3;
const inSettingsRoot = (s: Snapshot) => ["Airplane Mode", "Bluetooth", "General"].some((l) => s.elements.some((e) => e.label === l));
/** Settings' search field sits at the bottom; OCR reads its magnifier as "Q". */
const searchField = (s: Snapshot) =>
  s.elements.find((e) => (e.role === "search_field" || /(^|\s)search$/i.test(e.label)) && e.frame.y > s.screen.h * 0.75);
/** iph: the back button is a button in the top-left corner, labelled with the previous page's title. */
const backButton = (s: Snapshot) => s.elements.find((e) => e.role === "button" && e.frame.x < 60 && e.frame.y < 130);
// Icon-only controls OCR cannot read, at their place on this phone (content points).
const BACK = { x: 29, y: 65 };
const CLOSE_SEARCH = { x: 269, y: 634 };

/** Leaves Settings' search mode (escape clears the field, the close button ends the search). */
async function leaveSearch(): Promise<void> {
  await pilot.key("escape");
  if (mode === "ocr") await pilot.tap(CLOSE_SEARCH);
  else await pilot.tap("close");
}

/** Settings root scrolled so "General" shows; starts from the Home Screen. */
async function openSettingsRoot(): Promise<Snapshot> {
  await pilot.home();
  await until(onHome);
  const t = await pilot.tap("Settings");
  if (t.outcome !== "done") throw new Error(`tap Settings: ${brief(t)}`);
  let s = await until((x) => !onHome(x));
  // Settings reopens where it was left: in search mode, or on a sub-page (walk back).
  for (let i = 0; i < 6 && !inSettingsRoot(s); i++) {
    const back = backButton(s);
    if (searchField(s) && s.elements.length < 8) await leaveSearch();
    else if (mode === "ocr") await pilot.tap(BACK);
    else if (back) await pilot.tap(back.ref);
    s = await pilot.snapshot();
  }
  for (let i = 0; i < 4 && !has("General")(s); i++) {
    await pilot.scroll("down");
    s = await pilot.snapshot();
  }
  return s;
}

type Case = { name: string; manual?: boolean; run: () => Promise<{ pass: boolean; detail: string }> };

const CASES: Case[] = [
  {
    name: "doctor reports ready",
    run: async () => {
      const d = await pilot.doctor();
      const m = d.modes[mode];
      return { pass: m.ready, detail: m.checks.map((c) => `${c.check}: ${c.ok ? "ok" : `FAIL (${c.user_action ?? c.detail})`}`).join("; ") };
    },
  },
  {
    name: "snapshot of the Home Screen (size vs a PNG screenshot)",
    run: async () => {
      await pilot.home();
      const s = await until(onHome);
      const t = Date.now();
      const snap = await pilot.snapshot();
      const ms = Date.now() - t;
      const png = join(tmpdir(), `probe-${mode}.png`);
      await pilot.screenshot(png);
      const pngBytes = existsSync(png) ? statSync(png).size : 0;
      rmSync(png, { force: true });
      const bytes = JSON.stringify(snap).length;
      return {
        pass: onHome(s) && snap.elements.length > 0,
        detail: `${snap.elements.length} elements, ${ms} ms, ${bytes} B JSON vs ${pngBytes} B PNG (${pngBytes ? Math.round(pngBytes / bytes) : "?"}x smaller)`,
      };
    },
  },
  {
    name: "tap an app by its name (Settings) opens it",
    run: async () => {
      await pilot.home();
      await until(onHome);
      const o = await pilot.tap("Settings");
      const s = await until((x) => !onHome(x));
      return { pass: o.outcome === "done" && o.screen_changed === true && !onHome(s), detail: brief(o) };
    },
  },
  {
    name: "scroll down then up",
    run: async () => {
      const a = await openSettingsRoot();
      const down = await pilot.scroll("down");
      const b = await pilot.snapshot();
      const up = await pilot.scroll("up");
      const c = await pilot.snapshot();
      return { pass: down.outcome === "done" && up.outcome === "done" && changed(a, b) && changed(b, c), detail: `down ${brief(down)} moved=${changed(a, b)}; up ${brief(up)} moved=${changed(b, c)}` };
    },
  },
  {
    name: "tap Settings search, type ASCII + Vietnamese, submit",
    run: async () => {
      const root = await openSettingsRoot();
      const field = searchField(root);
      if (!field) return { pass: false, detail: "no search field on the Settings root" };
      const tap = await pilot.tap(field.ref);
      await sleep(800);
      const ascii = await pilot.type("wifi");
      const vi = await pilot.type(" Tiếng Việt", { submit: true });
      const s = await pilot.snapshot();
      const shown = s.elements.some((e) => `${e.label} ${e.value ?? ""}`.includes("wifi Tiếng Việt"));
      const seen = s.elements.filter((e) => /wifi|ti[eế]ng|vi[eệ]t/i.test(`${e.label} ${e.value ?? ""}`)).map((e) => e.label).join(" / ");
      await leaveSearch();
      return {
        pass: tap.outcome === "done" && ascii.ok && vi.ok && shown,
        detail: `tap ${brief(tap)}; "wifi" ${brief(ascii)}; " Tiếng Việt"+submit ${brief(vi)}; on screen: ${shown} (${seen})`,
      };
    },
  },
  {
    name: "key escape and return (on the Home Screen, where they change nothing)",
    run: async () => {
      await pilot.home();
      await until(onHome);
      const esc = await pilot.key("escape");
      const ret = await pilot.key("return");
      return { pass: esc.outcome === "done" && ret.outcome === "done", detail: `escape ${brief(esc)}; return ${brief(ret)}` };
    },
  },
  {
    name: "home",
    run: async () => {
      const o = await pilot.home();
      const s = await until(onHome);
      return { pass: o.outcome === "done" && onHome(s), detail: brief(o) };
    },
  },
  {
    name: "tap a stale ref is refused (not_sent), nothing sent",
    run: async () => {
      const s = await openSettingsRoot();
      const general = s.elements.find((e) => e.label === "General") as Element;
      await pilot.home();
      // No snapshot here: a snapshot replaces the stored refs, and the point is that this ref is stale.
      await sleep(1500);
      const o = await pilot.tap(general.ref);
      const after = await pilot.snapshot();
      return { pass: o.outcome === "not_sent" && onHome(after), detail: `${general.ref}=General after going home: ${brief(o)}` };
    },
  },
  {
    name: "tap missing text is refused (not_sent)",
    run: async () => {
      const o = await pilot.tap("No Such Thing 42");
      return { pass: o.outcome === "not_sent" && o.error?.code === "not_found", detail: brief(o) };
    },
  },
  {
    name: "screenshot fallback",
    run: async () => {
      const png = join(tmpdir(), `probe-shot-${mode}.png`);
      const o = await pilot.screenshot(png);
      const ok = existsSync(png) && statSync(png).size > 1000;
      const size = ok ? statSync(png).size : 0;
      rmSync(png, { force: true });
      return { pass: o.outcome === "done" && ok, detail: `${brief(o)} ${size} B` };
    },
  },
  {
    name: "swipe left and right (Home Screen pages)",
    run: async () => {
      await pilot.home();
      const a = await until(onHome);
      const l = await pilot.swipe("left");
      const b = await pilot.snapshot();
      const r = await pilot.swipe("right");
      const c = await until(onHome, 3000);
      return { pass: l.outcome === "done" && r.outcome === "done" && changed(a, b) && onHome(c), detail: `left ${brief(l)} moved=${changed(a, b)}; right ${brief(r)} back=${onHome(c)}` };
    },
  },
  ...(mode === "ocr" ? ocrFailureCases() : iphFailureCases()),
];

function ocrFailureCases(): Case[] {
  const mirrorWindowAX = (minimized: boolean) =>
    Bun.spawnSync(["osascript", "-e", `tell application "System Events" to tell process "iPhone Mirroring" to set value of attribute "AXMinimized" of (first window whose name is "iPhone Mirroring") to ${minimized}`]);
  return [
    {
      name: "mirror covered by the front app: input lands only in the mirror, front app restored",
      run: async () => {
        Bun.spawnSync(["open", "-a", "Finder"]);
        await sleep(800);
        const before = front();
        await pilot.home();
        await until(onHome);
        const o = await pilot.tap("Settings");
        const after = front();
        const s = await until((x) => !onHome(x));
        await pilot.home();
        return { pass: o.outcome === "done" && !onHome(s) && after === before, detail: `front before=${before} after=${after}; ${brief(o)}` };
      },
    },
    {
      name: "mirror under an always-on-top window: refused (not_sent), front app restored",
      run: async () => {
        const win = JSON.parse(Bun.spawnSync([helper, "window"]).stdout.toString());
        const b = win.bounds;
        const cover = Bun.spawn([coverBin, String(b.x), String(b.y), String(b.w), String(b.h), "8"]);
        await sleep(1500);
        const before = front();
        const o = await pilot.tap({ x: 150, y: 300 });
        const after = front();
        cover.kill();
        await cover.exited;
        return { pass: o.outcome === "not_sent" && o.error?.code === "mirror_covered" && after === before, detail: `front before=${before} after=${after}; ${brief(o)}` };
      },
    },
    {
      name: "mirror window minimized: refused with a clear message",
      run: async () => {
        mirrorWindowAX(true);
        await sleep(1200);
        const o = await pilot.tap({ x: 150, y: 300 });
        const d = await pilot.doctor();
        mirrorWindowAX(false);
        await sleep(1200);
        const vis = d.modes.ocr.checks.find((c) => c.check === "window visible");
        return { pass: o.outcome === "not_sent" && o.error?.code === "mirror_hidden" && vis?.ok === false, detail: `${brief(o)} "${o.error?.user_action}"; doctor: ${vis?.detail} -> ${vis?.user_action}` };
      },
    },
    {
      name: "phone unlocked (mirror session ended): refused, doctor says how to reconnect",
      manual: true,
      run: async () => {
        const o = await pilot.tap({ x: 150, y: 300 });
        const snap = await pilot.snapshot().then(() => "read ok", (e) => `read refused: ${e.outcome?.error?.code}`);
        const d = await pilot.doctor();
        const c = d.modes.ocr.checks.find((x) => x.check === "phone connected");
        return { pass: o.outcome === "not_sent" && o.error?.code === "mirror_disconnected" && c?.ok === false, detail: `${brief(o)}; ${snap}; doctor: ${c?.detail} -> ${c?.user_action}` };
      },
    },
    {
      name: "iPhone Mirroring not running: refused, doctor says how to fix",
      manual: true,
      run: async () => {
        Bun.spawnSync(["osascript", "-e", 'tell application "iPhone Mirroring" to quit']);
        await sleep(2500);
        const o = await pilot.tap({ x: 150, y: 300 });
        const snap = await pilot.snapshot().then(() => "read ok", (e) => `read refused: ${e.outcome?.error?.code}`);
        const d = await pilot.doctor();
        const w = d.modes.ocr.checks.find((c) => c.check === "iPhone Mirroring window");
        Bun.spawnSync(["open", "-a", "iPhone Mirroring"]);
        return { pass: o.outcome === "not_sent" && o.error?.code === "mirror_not_running" && w?.ok === false, detail: `${brief(o)}; ${snap}; doctor: ${w?.detail} -> ${w?.user_action}` };
      },
    },
  ];
}

function iphFailureCases(): Case[] {
  return [
    {
      name: "iph absent from PATH: not_sent iph_missing with install action",
      run: async () => {
        const saved = process.env.PATH;
        process.env.PATH = "/usr/bin:/bin";
        try {
          const o = await createPilot({ mode: "iph", stateDir }).home();
          return { pass: o.outcome === "not_sent" && o.error?.code === "iph_missing", detail: `${brief(o)} "${o.error?.user_action}"` };
        } finally {
          process.env.PATH = saved;
        }
      },
    },
    {
      // Run with the phone locked and face down (Face ID would unlock it). iph has no lock refusal of
      // its own: a locked phone reads as its Lock Screen, and input reaches that screen.
      name: "phone locked: snapshot is the Lock Screen, app taps refused, doctor says unlock",
      manual: true,
      run: async () => {
        const s = await pilot.snapshot();
        const o = await pilot.tap("Settings");
        const d = await pilot.doctor();
        const lock = d.modes.iph.checks.find((c) => c.check === "screen_unlocked");
        const lockScreen = s.elements.some((e) => e.label === "Flashlight") && !onHome(s);
        return {
          pass: lockScreen && o.outcome === "not_sent" && lock?.ok === false,
          detail: `snapshot: ${s.elements.map((e) => e.label.split(",")[0]).join(" / ")}; tap Settings ${brief(o)}; doctor screen_unlocked: ${lock?.detail} -> ${lock?.user_action}`,
        };
      },
    },
  ];
}

const selected = values.only?.length ? CASES.filter((c) => values.only!.some((o) => c.name.includes(o))) : CASES.filter((c) => !c.manual);
const results: Result[] = [];
for (const c of selected) {
  const t = Date.now();
  let r: { pass: boolean; detail: string };
  try {
    r = await c.run();
  } catch (e) {
    r = { pass: false, detail: `threw: ${e instanceof Error ? e.message : String(e)}` };
  }
  const res = { name: c.name, ms: Date.now() - t, ...r };
  results.push(res);
  console.log(`${res.pass ? "PASS" : "FAIL"} ${res.name} (${res.ms} ms): ${res.detail}`);
}

// Merge into docs/probe-results.md: rows keyed by case name inside this mode's section.
const doc = join(root, "docs", "probe-results.md");
mkdirSync(join(root, "docs"), { recursive: true });
const start = `<!-- probe:${mode}:start -->`, end = `<!-- probe:${mode}:end -->`;
let text = existsSync(doc) ? readFileSync(doc, "utf8") : "# Probe results\n\nLive runs of `bun run probe` on a real iPhone. Each row is the latest run of that case.\n";
const section = text.includes(start) ? text.slice(text.indexOf(start), text.indexOf(end) + end.length) : "";
const rows = new Map<string, string>();
for (const line of section.split("\n")) {
  const m = /^\| (.+?) \| (PASS|FAIL) \|/.exec(line);
  if (m) rows.set(m[1]!, line);
}
const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
for (const r of results) rows.set(cell(r.name), `| ${cell(r.name)} | ${r.pass ? "PASS" : "FAIL"} | ${r.ms} | ${cell(r.detail)} | ${stamp} |`);
const order = CASES.map((c) => cell(c.name));
const body = [...rows.entries()].filter(([name]) => order.includes(name)).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([, l]) => l);
const block = [start, `## ${mode} mode`, "", "| case | result | ms | detail | run (UTC) |", "|---|---|---|---|---|", ...body, end].join("\n");
text = section ? text.replace(section, block) : `${text.trimEnd()}\n\n${block}\n`;
writeFileSync(doc, text);
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed -> ${doc}`);
