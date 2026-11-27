import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPilot } from "../src/index.ts";

const root = join(import.meta.dir, "..");
const fakeBin = join(import.meta.dir, "fixtures", "bin");
const settingsPng = join(import.meta.dir, "fixtures", "settings.png");
const homePng = join(import.meta.dir, "fixtures", "home.png");
const originalPath = process.env.PATH;
const originalHelper = process.env.IPHONE_PILOT_HELPER;

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
  delete process.env.FAKE_IPH_FRONT;
  delete process.env.FAKE_IPH_SCREEN;
  delete process.env.FAKE_MIRROR_STREAMING;
  if (originalHelper === undefined) delete process.env.IPHONE_PILOT_HELPER;
  else process.env.IPHONE_PILOT_HELPER = originalHelper;
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

test("ocr snapshot of the Home Screen gives an app's name the frame of its icon, so tapping the name opens the app", async () => {
  const snap = await createPilot({ mode: "ocr", image: homePng, stateDir: dir }).snapshot();
  const settings = snap.elements.find((e) => e.label === "Settings")!;
  expect(settings.role).toBe("app_icon");
  // The icon sits above its label; on this capture the label's text starts at y≈511.
  const { y, h } = settings.frame;
  expect(y + h).toBeLessThanOrEqual(511);
  expect(h).toBeGreaterThanOrEqual(40);
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

test("an iph action outcome leaves out the screen iph re-read, so it stays small", async () => {
  const out = await iph().tap({ x: 100, y: 200 });
  expect(Object.keys(out).filter((k) => ["elements", "screen", "apps"].includes(k))).toEqual([]);
});

test("a ref whose element disappeared is refused as stale_ref, as in ocr mode", async () => {
  await iph().snapshot();
  const out = await iph().tap("e5");
  expect(out).toMatchObject({ ok: false, outcome: "not_sent", error: { code: "stale_ref" } });
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

test("doctor puts the phone back on the app it found", async () => {
  process.env.FAKE_IPH_FRONT = "Notes";
  const report = await iph().doctor();
  expect(report.modes.iph.ready).toBe(true);
  const commands = invoked().map((a) => a.join(" "));
  expect(commands.filter((c) => c.startsWith("doctor"))).toEqual(["doctor --no-touch-test"]);
  expect(commands.indexOf("launch Notes")).toBeGreaterThan(commands.indexOf("doctor --no-touch-test"));
});

test("a ref from an earlier read is refused once its element is gone, instead of tapping whatever took its number", async () => {
  const before = await iph().snapshot();
  const general = before.elements.find((e) => e.label === "General")!;
  process.env.FAKE_IPH_SCREEN = "b";
  const after = await iph().snapshot();
  expect(after.elements.map((e) => e.label)).toContain("Bluetooth");

  const out = await iph().tap(general.ref);
  expect(out).toMatchObject({ ok: false, outcome: "not_sent", error: { code: "stale_ref" } });
  expect(inputCommands()).toEqual([]);
});

test("auto uses ocr while Mirroring shows the phone and moves to iph once it stops", async () => {
  process.env.IPHONE_PILOT_HELPER = join(fakeBin, "mirror-helper-fake");
  const pilot = createPilot({ stateDir: dir });
  process.env.FAKE_MIRROR_STREAMING = "1";
  expect((await pilot.snapshot()).mode).toBe("ocr");
  process.env.FAKE_MIRROR_STREAMING = "0";
  expect((await pilot.snapshot()).mode).toBe("iph");
});

test("after auto switches mode, a ref from the other mode's read is refused and nothing is sent", async () => {
  process.env.IPHONE_PILOT_HELPER = join(fakeBin, "mirror-helper-fake");
  await iph().snapshot(); // an older iph read whose refs overlap the ocr ones
  const pilot = createPilot({ stateDir: dir });
  process.env.FAKE_MIRROR_STREAMING = "1";
  const ocrRef = (await pilot.snapshot()).elements[0]!.ref;
  process.env.FAKE_MIRROR_STREAMING = "0";
  const out = await pilot.tap(ocrRef);
  expect(out).toMatchObject({ ok: false, outcome: "not_sent", error: { code: "stale_ref" } });
  expect(inputCommands()).toEqual([]);
});
