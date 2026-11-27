import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check, Direction, Driver, DriverElement, ModeReport, Outcome } from "../model.ts";
import { ReadError, notSent } from "../model.ts";
import { readingOrder } from "../order.ts";

const BUILD = "run: bun run build:helper";
const OPEN_MIRROR = "open the iPhone Mirroring app on this Mac and connect your iPhone";
const PRIVACY =
  "System Settings > Privacy & Security: enable Accessibility and Screen & System Audio Recording for the app that runs iphone-pilot (your terminal or agent), then restart it";

export interface OcrOptions {
  /** Read this saved capture instead of the live mirror window; every input is refused. */
  image?: string;
}

interface OcrLine {
  text: string;
  frame: { x: number; y: number; w: number; h: number };
  /** The app icon this text labels (Home Screen, folders): only the icon takes a tap. */
  icon?: { x: number; y: number; w: number; h: number };
}
interface Read {
  screen: { w: number; h: number };
  elements: DriverElement[];
}

function helperPath(): string {
  return process.env.IPHONE_PILOT_HELPER ?? join(import.meta.dir, "..", "..", "bin", "mirror-helper");
}

type Json = Record<string, any>;

/** One helper call; its single JSON object, or an Outcome when the helper itself is unusable. */
async function helper(args: string[]): Promise<{ json: Json } | { fail: Outcome }> {
  const bin = helperPath();
  if (!existsSync(bin)) {
    return { fail: notSent("helper_missing", `the Swift helper is not built (${bin})`, { user_action: BUILD }) };
  }
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  try {
    return { json: JSON.parse(out) };
  } catch {
    const message = `mirror-helper ${args[0]} exited ${exit}: ${err.trim() || "no output"}`;
    // A crash after input began may have sent part of it; a usage error (64) sent nothing.
    return { fail: exit === 64 ? notSent("helper_usage", message) : { ok: false, outcome: "unknown", error: { code: "helper_crashed", message } } };
  }
}

async function input(args: string[]): Promise<Outcome> {
  const r = await helper(args);
  return "fail" in r ? r.fail : (r.json as Outcome);
}

const RECONNECT = "lock the iPhone, then click Connect in the iPhone Mirroring window";
const disconnected = (message?: string) =>
  notSent("mirror_disconnected", `iPhone Mirroring is not showing the phone${message ? ` (it says: ${message})` : ""}`, { user_action: RECONNECT });

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

export function createOcrDriver(opts: OcrOptions = {}): Driver {
  const readOnly = () =>
    notSent("read_only_image", "ocr was started on a saved image (--image), which cannot take input", {
      user_action: "run without --image to drive the live iPhone Mirroring window",
    });
  let lastLines: OcrLine[] = [];

  async function ocrFile(path: string): Promise<Read> {
    const r = await helper(["ocr", path]);
    if ("fail" in r) throw new ReadError(r.fail);
    if (r.json.error) throw new ReadError(notSent(r.json.error.code ?? "ocr_failed", r.json.error.message ?? "ocr failed"));
    const lines: OcrLine[] = (r.json.lines ?? []).filter((l: OcrLine) => l.text.trim() !== "");
    const elements = readingOrder(
      lines.map((l): DriverElement => {
        const f = l.icon ?? l.frame;
        return { role: l.icon ? "app_icon" : "text", label: l.text, frame: { x: f.x, y: f.y, w: f.w, h: f.h }, source: "ocr" };
      }),
    );
    lastLines = elements.map((e) => ({ text: e.label, frame: e.frame }));
    return { screen: { w: r.json.screen.w, h: r.json.screen.h }, elements };
  }

  async function read(): Promise<Read> {
    if (opts.image) return ocrFile(opts.image);
    const dir = mkdtempSync(join(tmpdir(), "iphone-pilot-"));
    try {
      const path = join(dir, "capture.png");
      const c = await helper(["capture", path]);
      if ("fail" in c) throw new ReadError(c.fail);
      if (c.json.ok !== true) {
        const e = c.json.error ?? {};
        throw new ReadError(notSent(e.code ?? "capture_failed", e.message ?? "capture failed", { user_action: e.user_action }));
      }
      // The window then shows Mirroring's own screen ("iPhone in Use" …), not the phone.
      if (c.json.streaming === false) throw new ReadError(disconnected(c.json.message));
      return await ocrFile(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Status bar text (clock, signal) changes on its own; it must not count as a screen change. */
  const body = (lines: OcrLine[]) => new Set(lines.filter((l) => l.frame.y > 44).map((l) => l.text));
  const differs = (a: Set<string>, b: Set<string>) => a.size !== b.size || [...a].some((t) => !b.has(t));

  /** Clicks, then OCRs until the screen differs from `before` or ~3 s pass (app launches animate). */
  async function clickAndObserve(x: number, y: number, before: OcrLine[]): Promise<Outcome> {
    const out = await input(["click", String(Math.round(x)), String(Math.round(y))]);
    if (out.outcome !== "done") return out;
    const was = body(before);
    let changed = false;
    const deadline = Date.now() + 3000;
    while (!changed && Date.now() < deadline) {
      try {
        await read();
      } catch {
        break;
      }
      changed = differs(was, body(lastLines));
    }
    return { ...out, screen_changed: changed };
  }

  const centre = (e: Pick<DriverElement, "frame">) => ({ x: e.frame.x + e.frame.w / 2, y: e.frame.y + e.frame.h / 2 });

  const driver: Driver = {
    mode: "ocr",

    async doctor(): Promise<ModeReport> {
      const checks: Check[] = [];
      const built = existsSync(helperPath());
      checks.push({ check: "helper built", ok: built, ...(built ? {} : { detail: `missing ${helperPath()}`, user_action: BUILD }) });
      if (!built) return { ready: false, checks };

      const perms = await helper(["perms"]);
      const p = "json" in perms ? perms.json : {};
      checks.push({ check: "accessibility permission", ok: p.accessibility === true, ...(p.accessibility === true ? {} : { user_action: PRIVACY }) });
      checks.push({ check: "screen recording permission", ok: p.screen_recording === true, ...(p.screen_recording === true ? {} : { user_action: PRIVACY }) });

      const w = await helper(["window"]);
      const win = "json" in w ? w.json : {};
      checks.push({
        check: "iPhone Mirroring window",
        ok: win.found === true,
        ...(win.found === true ? { detail: `${win.bounds.w}x${win.bounds.h}` } : { detail: win.running ? "app running, no phone window" : "app not running", user_action: OPEN_MIRROR }),
      });
      if (win.found === true) {
        const visible = win.on_screen === true && win.minimized !== true;
        checks.push({
          check: "window visible",
          ok: visible,
          ...(visible ? {} : { detail: win.minimized ? "minimized" : "not on screen", user_action: win.minimized ? "un-minimize the iPhone Mirroring window" : "show the iPhone Mirroring window (click its Dock icon)" }),
        });
        const streaming = win.streaming !== false;
        checks.push({ check: "phone connected", ok: streaming, ...(streaming ? {} : { detail: win.message, user_action: RECONNECT }) });
      }
      return { ready: checks.every((c) => c.ok), checks };
    },

    read,

    async tapElement(el, { fresh }) {
      if (opts.image) return readOnly();
      if (!fresh) {
        // Refs are only as good as the screen they came from: require the same label where it was.
        let now: Read;
        try {
          now = await read();
        } catch (e) {
          if (e instanceof ReadError) return e.outcome;
          throw e;
        }
        const c = centre(el);
        const tol = Math.max(12, el.frame.h / 2);
        const hit = now.elements.find((n) => {
          const m = centre(n);
          return n.label === el.label && Math.hypot(m.x - c.x, m.y - c.y) <= tol;
        });
        if (!hit) {
          return notSent("stale_ref", `"${el.label}" is no longer where the last snapshot saw it`, {
            user_action: "run snapshot again and use a fresh ref",
          });
        }
        const m = centre(hit);
        return clickAndObserve(m.x, m.y, lastLines);
      }
      const c = centre(el);
      return clickAndObserve(c.x, c.y, lastLines);
    },

    async tapPoint(x, y) {
      if (opts.image) return readOnly();
      try {
        await read();
      } catch (e) {
        if (e instanceof ReadError) return e.outcome;
        throw e;
      }
      return clickAndObserve(x, y, lastLines);
    },

    // Text is pasted through Universal Clipboard, and about one paste in ten inserts the phone's
    // previous clipboard item instead of the new one (measured live). So a paste is checked on
    // screen: nothing inserted → paste again; something else inserted → undo it (Cmd+Z) and paste
    // again, but only when the undo provably restored the screen. Anything else is `unknown`.
    async type(text, { submit }) {
      if (opts.image) return readOnly();
      const want = norm(text);
      const count = () => (want === "" ? 0 : norm(lastLines.map((l) => l.text).join(" ")).split(want).length - 1);
      const unverified = (sent: Outcome, attempts: number): Outcome => ({
        ...sent,
        ok: false,
        outcome: "unknown",
        attempts,
        error: {
          code: "type_not_verified",
          message: "the text was sent but could not be seen on screen afterwards",
          hint: "check the screen; do not retype, it may already be entered",
        },
      });
      try {
        await read();
      } catch (e) {
        if (e instanceof ReadError) return e.outcome;
        throw e;
      }
      const before = body(lastLines);
      const had = count();
      const ATTEMPTS = 3;
      for (let attempt = 1; ; attempt++) {
        const sent = await input(["type", text]);
        if (sent.outcome !== "done") return attempt === 1 ? sent : { ...sent, outcome: "unknown", ok: false };
        let seen = want === "";
        for (let i = 0; i < 3 && !seen; i++) {
          try {
            await read();
          } catch {
            return unverified(sent, attempt);
          }
          seen = count() > had;
        }
        if (seen) {
          if (!submit) return { ...sent, verified: true, ...(attempt > 1 ? { attempts: attempt } : {}) };
          const enter = await input(["key", "return"]);
          return { ...enter, verified: true, ...(attempt > 1 ? { attempts: attempt } : {}) };
        }
        if (attempt === ATTEMPTS) return unverified(sent, attempt);
        if (differs(before, body(lastLines))) {
          const undo = await input(["key", "cmd+z"]);
          if (undo.outcome !== "done") return unverified(sent, attempt);
          try {
            await read();
          } catch {
            return unverified(sent, attempt);
          }
          if (differs(before, body(lastLines))) return unverified(sent, attempt);
        }
      }
    },

    async key(name) {
      return opts.image ? readOnly() : input(["key", name]);
    },

    async swipe(dir: Direction) {
      if (opts.image) return readOnly();
      // The mirror ignores synthetic mouse drags, but moves the content for wheel events, so a
      // swipe is a scroll in the opposite direction (finger up = see what is further down).
      const [wheel, steps] = { up: ["down", 3], down: ["up", 3], left: ["right", 5], right: ["left", 5] }[dir] as [string, number];
      return input(["scroll", wheel, String(steps)]);
    },

    async scroll(dir) {
      return opts.image ? readOnly() : input(["scroll", dir]);
    },

    async home() {
      return opts.image ? readOnly() : input(["menu", "home"]);
    },

    async screenshot(path) {
      if (opts.image) return readOnly();
      const r = await helper(["capture", path]);
      if ("fail" in r) return r.fail;
      if (r.json.ok !== true) {
        const e = r.json.error ?? {};
        return notSent(e.code ?? "capture_failed", e.message ?? "capture failed", { user_action: e.user_action });
      }
      return { ok: true, outcome: "done", path };
    },
  };
  return driver;
}

