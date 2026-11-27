import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPilot } from "../src/index.ts";

const root = join(import.meta.dir, "..");
const fakeBin = join(import.meta.dir, "fixtures", "bin");
const settingsPng = join(import.meta.dir, "fixtures", "settings.png");
const originalPath = process.env.PATH;

let dir: string;
let log: string;

beforeAll(() => {
  if (!existsSync(join(root, "bin", "mirror-helper"))) {
    const built = Bun.spawnSync(["bun", "run", "build:helper"], { cwd: root });
    if (built.exitCode !== 0) throw new Error(`build:helper failed: ${built.stderr.toString()}`);
  }
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "iphone-pilot-test-"));
  log = join(dir, "iph.log");
  process.env.FAKE_IPH_LOG = log;
  process.env.PATH = `${fakeBin}:${originalPath}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_IPH_LOG;
  rmSync(dir, { recursive: true, force: true });
});

const iph = () => createPilot({ mode: "iph", stateDir: dir });
const invoked = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);
const inputCommands = () => invoked().filter(([c]) => !["read", "devices", "doctor"].includes(c!));

test("ocr snapshot of a saved Settings capture finds General inside the screen", async () => {
  const snap = await createPilot({ mode: "ocr", image: settingsPng, stateDir: dir }).snapshot();
  const general = snap.elements.find((e) => e.label === "General");
  expect(general).toBeDefined();
  const { x, y, w, h } = general!.frame;
  expect(x).toBeGreaterThanOrEqual(0);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(x + w).toBeLessThanOrEqual(snap.screen.w);
  expect(y + h).toBeLessThanOrEqual(snap.screen.h);
});

test("iph snapshot maps the accessibility tree into refs e1..eN in reading order", async () => {
  const snap = await iph().snapshot();
  expect(snap.mode).toBe("iph");
  expect(snap.screen).toEqual({ w: 402, h: 874 });
  expect(snap.elements.map((e) => `${e.ref}:${e.label}`)).toEqual(["e1:Settings", "e2:Airplane Mode", "e3:Wi-Fi", "e4:General", "e5:Vanishing"]);
  expect(snap.elements[3]).toEqual({ ref: "e4", role: "button", label: "General", frame: { x: 16, y: 400, w: 370, h: 44 }, source: "ax" });
});

test("tapping a ref from an earlier snapshot taps that element and reports screen_changed", async () => {
  await iph().snapshot();
  const out = await iph().tap("e4");
  expect(out).toMatchObject({ ok: true, outcome: "done", screen_changed: true });
});

test("an element that disappeared makes iph's not_found come back as not_sent", async () => {
  await iph().snapshot();
  const out = await iph().tap("e5");
  expect(out).toMatchObject({ ok: false, outcome: "not_sent", error: { code: "not_found" } });
});

test("without iph on PATH every command is not_sent iph_missing with the install action", async () => {
  process.env.PATH = "/usr/bin:/bin";
  const out = await iph().home();
  expect(out).toMatchObject({ ok: false, outcome: "not_sent", error: { code: "iph_missing" } });
  expect(out.error?.user_action).toContain("install.sh");
});

test("a ref that is not in the last snapshot is refused as stale_ref and no input reaches iph", async () => {
  await iph().snapshot();
  const out = await iph().tap("e999");
  expect(out).toMatchObject({ ok: false, outcome: "not_sent", error: { code: "stale_ref" } });
  expect(inputCommands()).toEqual([]);
});

test("tapping text that is not on screen is refused as not_found and no input reaches iph", async () => {
  const out = await iph().tap("No Such Label");
  expect(out).toMatchObject({ ok: false, outcome: "not_sent", error: { code: "not_found" } });
  expect(inputCommands()).toEqual([]);
});
