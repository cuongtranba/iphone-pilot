import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createIphDriver, iphReady } from "./drivers/iph.ts";
import { createOcrDriver, mirrorStreaming } from "./drivers/ocr.ts";
import {
  type Direction,
  type DoctorReport,
  type Driver,
  type DriverElement,
  type Element,
  type Mode,
  type Outcome,
  type Snapshot,
  type Target,
  KEY_NAMES,
  ReadError,
  notSent,
} from "./model.ts";

export interface PilotOptions {
  mode?: Mode | "auto";
  /** ocr mode only: read a saved capture instead of the live mirror window; input is refused. */
  image?: string;
  /** Where the last snapshot of each mode is kept so refs survive across CLI processes. */
  stateDir?: string;
}

export interface Pilot {
  doctor(): Promise<DoctorReport>;
  snapshot(): Promise<Snapshot>;
  find(text: string): Promise<Snapshot>;
  tap(target: Target): Promise<Outcome>;
  type(text: string, opts?: { submit?: boolean }): Promise<Outcome>;
  key(name: string): Promise<Outcome>;
  swipe(dir: Direction): Promise<Outcome>;
  scroll(dir: "up" | "down"): Promise<Outcome>;
  home(): Promise<Outcome>;
  screenshot(path: string): Promise<Outcome>;
}

interface Stored {
  snapshot: Snapshot;
  native: Record<string, string>;
  /** The next unused ref number; numbers are never reused. Absent in files written before refs were stable. */
  next?: number;
}

const REF = /^e\d+$/;

function defaultStateDir(): string {
  return process.env.IPHONE_PILOT_STATE_DIR ?? join(homedir(), "Library", "Caches", "iphone-pilot");
}

export function createPilot(opts: PilotOptions = {}): Pilot {
  const requested = opts.mode ?? "auto";
  const stateDir = opts.stateDir ?? defaultStateDir();
  const drivers: Partial<Record<Mode, Driver>> = {};

  /**
   * auto decides per command, so it follows the phone: Mirroring streams only while the phone is
   * locked (iph cannot work then), otherwise iph when a device is ready, otherwise ocr.
   */
  const chooseMode = async (): Promise<Mode> => {
    if (requested !== "auto") return requested;
    if (await mirrorStreaming()) return "ocr";
    return (await iphReady()) ? "iph" : "ocr";
  };

  const driver = async (): Promise<Driver> => {
    const mode = await chooseMode();
    return (drivers[mode] ??= mode === "iph" ? createIphDriver() : createOcrDriver({ image: opts.image }));
  };

  // One latest read for both modes: refs belong to it, so after auto switches mode an old ref is
  // refused instead of resolving against an older read of the other mode.
  const statePath = join(stateDir, "last-read.json");
  const load = (): Stored | undefined => {
    try {
      return JSON.parse(readFileSync(statePath, "utf8")) as Stored;
    } catch {
      return undefined;
    }
  };

  async function read(d: Driver): Promise<Stored> {
    const raw = await d.read();
    const before = load();
    const native: Record<string, string> = {};
    const refs = assignRefs(raw.elements, before, d.mode);
    const elements: Element[] = raw.elements.map((e, i) => {
      const { native: n, ...rest } = e;
      const ref = refs.refs[i]!;
      if (n !== undefined) native[ref] = n;
      return { ref, ...rest };
    });
    const stored: Stored = { snapshot: { mode: d.mode, screen: raw.screen, elements }, native, next: refs.next };
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(stored));
    return stored;
  }

  const forDriver = (e: Element, native: Record<string, string>): DriverElement => {
    const { ref, ...rest } = e;
    const n = native[ref];
    return n === undefined ? rest : { ...rest, native: n };
  };

  return {
    async doctor() {
      const ocr = await createOcrDriver({ image: opts.image }).doctor();
      const iph = await createIphDriver().doctor();
      const active = await chooseMode();
      return { mode: active, ready: (active === "iph" ? iph : ocr).ready, modes: { ocr, iph } };
    },

    async snapshot() {
      return (await read(await driver())).snapshot;
    },

    async find(text) {
      const { snapshot } = await read(await driver());
      return { ...snapshot, elements: matches(snapshot.elements, text) };
    },

    async tap(target) {
      const d = await driver();
      if (typeof target !== "string") return d.tapPoint(target.x, target.y);

      if (REF.test(target)) {
        const stored = load();
        const el = stored?.snapshot.mode === d.mode ? stored.snapshot.elements.find((e) => e.ref === target) : undefined;
        if (!stored || !el) {
          const why = stored && stored.snapshot.mode !== d.mode ? `the last read was in ${stored.snapshot.mode} mode, now ${d.mode}` : "it is not in the last read";
          return notSent("stale_ref", `ref ${target} cannot be used: ${why}`, {
            user_action: "run snapshot again and use a ref from its output",
          });
        }
        const out = await d.tapElement(forDriver(el, stored.native), { fresh: false });
        // iph says not_found for an element that went away; both modes call that a stale ref.
        if (out.outcome === "not_sent" && out.error?.code === "not_found") {
          return notSent("stale_ref", `ref ${target} ("${el.label}") is no longer on screen`, { user_action: "run snapshot again and use a fresh ref" });
        }
        return out;
      }

      let read_: Stored;
      try {
        read_ = await read(d);
      } catch (e) {
        if (e instanceof ReadError) return e.outcome;
        throw e;
      }
      const { snapshot, native } = read_;
      const found = narrow(snapshot.elements, target);
      if (found.length === 0) return notSent("not_found", `no element matches "${target}"`, { hint: "run snapshot to see what is on screen" });
      if (found.length > 1) {
        return notSent("ambiguous", `${found.length} elements match "${target}"`, {
          hint: "tap one of the candidates by ref",
          candidates: found,
        });
      }
      return d.tapElement(forDriver(found[0]!, native), { fresh: true });
    },

    async type(text, o = {}) {
      return (await driver()).type(text, { submit: o.submit });
    },

    async key(name) {
      if (!(KEY_NAMES as readonly string[]).includes(name)) {
        return notSent("unknown_key", `unknown key "${name}"`, { hint: `use one of: ${KEY_NAMES.join(", ")}` });
      }
      return (await driver()).key(name);
    },

    async swipe(dir) {
      return (await driver()).swipe(dir);
    },
    async scroll(dir) {
      return (await driver()).scroll(dir);
    },
    async home() {
      return (await driver()).home();
    },
    async screenshot(path) {
      return (await driver()).screenshot(path);
    },
  };
}

const refNumber = (ref: string) => Number(ref.slice(1));

/**
 * A ref never names a different element: an element that matches one of the previous read (same
 * label and role, centre within max(12, h/2) of it, each previous element used once) keeps that ref;
 * every other element takes a number from a counter that only goes up. So an old ref either names
 * the same element in the same place or is absent from the latest read.
 */
function assignRefs(elements: DriverElement[], before: Stored | undefined, mode: Mode): { refs: string[]; next: number } {
  const all = before?.snapshot.elements ?? [];
  let next = before?.next ?? Math.max(0, ...all.map((e) => refNumber(e.ref))) + 1;
  // Elements of a read in the other mode are never the same element; the counter still carries on.
  const prev = before?.snapshot.mode === mode ? all : [];
  const used = new Set<Element>();
  const centre = (f: Element["frame"]) => ({ x: f.x + f.w / 2, y: f.y + f.h / 2 });
  const refs = elements.map((e) => {
    const c = centre(e.frame);
    let best: Element | undefined;
    let bestDist = Infinity;
    for (const p of prev) {
      if (used.has(p) || p.label !== e.label || p.role !== e.role) continue;
      const m = centre(p.frame);
      const dist = Math.hypot(m.x - c.x, m.y - c.y);
      if (dist <= Math.max(12, p.frame.h / 2) && dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    if (best) {
      used.add(best);
      return best.ref;
    }
    return `e${next++}`;
  });
  return { refs, next };
}

/** Case-insensitive contains over label and value. */
function matches(elements: Element[], text: string): Element[] {
  const q = text.toLowerCase();
  return elements.filter((e) => e.label.toLowerCase().includes(q) || (e.value ?? "").toLowerCase().includes(q));
}

/** A single exact (case-insensitive) label wins over looser contains matches; never pick among several. */
function narrow(elements: Element[], text: string): Element[] {
  const loose = matches(elements, text);
  const q = text.toLowerCase();
  const exact = loose.filter((e) => e.label.toLowerCase() === q);
  return exact.length > 0 ? exact : loose;
}
