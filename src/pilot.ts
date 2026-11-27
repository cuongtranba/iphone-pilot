import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createIphDriver, iphReady } from "./drivers/iph.ts";
import { createOcrDriver } from "./drivers/ocr.ts";
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
}

const REF = /^e\d+$/;

function defaultStateDir(): string {
  return process.env.IPHONE_PILOT_STATE_DIR ?? join(homedir(), "Library", "Caches", "iphone-pilot");
}

export function createPilot(opts: PilotOptions = {}): Pilot {
  const requested = opts.mode ?? "auto";
  const stateDir = opts.stateDir ?? defaultStateDir();
  let driverPromise: Promise<Driver> | undefined;

  const driver = (): Promise<Driver> =>
    (driverPromise ??= (async () => {
      const mode = requested === "auto" ? ((await iphReady()) ? "iph" : "ocr") : requested;
      return mode === "iph" ? createIphDriver() : createOcrDriver({ image: opts.image });
    })());

  const statePath = (mode: Mode) => join(stateDir, `last-snapshot-${mode}.json`);
  const load = (mode: Mode): Stored | undefined => {
    try {
      return JSON.parse(readFileSync(statePath(mode), "utf8")) as Stored;
    } catch {
      return undefined;
    }
  };

  async function read(d: Driver): Promise<Stored> {
    const raw = await d.read();
    const native: Record<string, string> = {};
    const elements: Element[] = raw.elements.map((e, i) => {
      const { native: n, ...rest } = e;
      const ref = `e${i + 1}`;
      if (n !== undefined) native[ref] = n;
      return { ref, ...rest };
    });
    const stored = { snapshot: { mode: d.mode, screen: raw.screen, elements }, native };
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePath(d.mode), JSON.stringify(stored));
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
      const active = requested === "auto" ? (iph.ready ? "iph" : "ocr") : requested;
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
        const stored = load(d.mode);
        const el = stored?.snapshot.elements.find((e) => e.ref === target);
        if (!stored || !el) {
          return notSent("stale_ref", `ref ${target} is not in the last ${d.mode} snapshot`, {
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
