import type { Check, Direction, Driver, DriverElement, ModeReport, Outcome } from "../model.ts";
import { ReadError, notSent } from "../model.ts";
import { readingOrder } from "../order.ts";

const INSTALL =
  "install iph: curl -fsSL https://raw.githubusercontent.com/HyunSeob/iphone-cli/main/install.sh | sh, then run: iph setup (USB Trust, Developer Mode, developer disk image; check with: iph doctor)";

interface Run {
  json: Record<string, any> | undefined;
  exit: number;
}

function iphPath(): string | null {
  return Bun.which("iph", { PATH: process.env.PATH ?? "" });
}

async function run(args: string[]): Promise<Run | "missing"> {
  const bin = iphPath();
  if (!bin) return "missing";
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
  const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  try {
    return { json: JSON.parse(out), exit };
  } catch {
    return { json: undefined, exit };
  }
}

/** iph is on PATH and `iph devices` shows a ready device. */
export async function iphReady(): Promise<boolean> {
  const r = await run(["devices"]);
  if (r === "missing" || !r.json) return false;
  return (r.json.devices ?? []).some((d: any) => d.ready === true);
}

const missing = () => notSent("iph_missing", "the iph command is not installed", { user_action: INSTALL });

/** iph's own outcome contract, 1:1; bulky observations are dropped to keep output small. */
function toOutcome(r: Run | "missing"): Outcome {
  if (r === "missing") return missing();
  if (!r.json) {
    const outcome = r.exit === 2 ? "unknown" : "not_sent";
    return { ok: false, outcome, error: { code: "iph_bad_output", message: `iph exited ${r.exit} without JSON` } };
  }
  // iph attaches the screen it re-read after the action (every element); an outcome stays small.
  const { element: _e, screen_summary: _s, screen: _sc, apps: _a, elements: _el, count: _c, seq: _q, pass: _p, ...rest } = r.json;
  return rest as Outcome;
}

export function createIphDriver(): Driver {
  const cmd = async (args: string[]) => toOutcome(await run(args));

  return {
    mode: "iph",

    async doctor(): Promise<ModeReport> {
      if (!iphPath()) {
        return { ready: false, checks: [{ check: "iph installed", ok: false, detail: "iph not found on PATH", user_action: INSTALL }] };
      }
      const d = await run(["doctor"]);
      if (d === "missing" || !d.json) {
        return { ready: false, checks: [{ check: "iph doctor", ok: false, detail: `iph doctor exited ${d === "missing" ? "?" : d.exit} without JSON`, user_action: "run: iph doctor" }] };
      }
      // Only iph's required checks decide readiness; its advice (wifi, auto_lock) stays as detail.
      const checks: Check[] = (d.json.checks ?? []).map((c: any) => {
        const ok = c.status === "ok" || c.required === false;
        const detail = [c.status !== "ok" ? c.status : "", c.detail ?? "", ok ? (c.user_action ?? "") : ""].filter(Boolean).join(": ");
        return { check: c.check, ok, ...(detail ? { detail } : {}), ...(ok ? {} : { user_action: c.user_action ?? "run: iph doctor" }) };
      });
      const ready = d.json.ready === true;
      if (!ready && !checks.some((c) => !c.ok)) {
        checks.push({ check: "iph ready", ok: false, user_action: "run: iph doctor" });
      }
      return { ready, checks };
    },

    async read() {
      const r = await run(["read"]);
      if (r === "missing") throw new ReadError(missing());
      if (!r.json || r.json.ok === false) {
        throw new ReadError(toOutcome(r));
      }
      const elements: DriverElement[] = [];
      for (const e of r.json.elements ?? []) {
        if (e.role === "application" || !e.frame || e.on_screen === false) continue;
        const label = e.label ?? e.value ?? e.identifier ?? "";
        elements.push({
          role: e.role,
          label,
          ...(e.value && e.value !== label ? { value: e.value } : {}),
          frame: { x: e.frame.x, y: e.frame.y, w: e.frame.w, h: e.frame.h },
          source: "ax",
          native: e.id,
        });
      }
      return { screen: { w: r.json.screen.width, h: r.json.screen.height }, elements: readingOrder(elements) };
    },

    tapElement(el) {
      if (el.native) return cmd(["tap", `id=${el.native}`]);
      return cmd(["tap", `${Math.round(el.frame.x + el.frame.w / 2)},${Math.round(el.frame.y + el.frame.h / 2)}`]);
    },
    tapPoint: (x, y) => cmd(["tap", `${Math.round(x)},${Math.round(y)}`]),
    type: (text, { submit }) => cmd(["type", ...(submit ? ["--submit"] : []), "--", text]),
    key: (name) => cmd(["key", name === "escape" ? "esc" : name === "delete" ? "backspace" : name]),
    swipe: (dir: Direction) => cmd(["swipe", dir]),
    scroll: (dir) => cmd(["scroll", dir]),
    home: () => cmd(["button", "home"]),
    screenshot: (path) => cmd(["screenshot", "-o", path]),
  };
}
