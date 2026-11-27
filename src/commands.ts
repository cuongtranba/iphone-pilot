import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pilot } from "./pilot.ts";
import { type Direction, type Outcome, ReadError } from "./model.ts";

/** The command set shared by the CLI and the MCP server. Results are plain JSON values. */
export type Command = "doctor" | "snapshot" | "find" | "tap" | "type" | "key" | "swipe" | "scroll" | "home" | "screenshot";

export const COMMANDS: Command[] = ["doctor", "snapshot", "find", "tap", "type", "key", "swipe", "scroll", "home", "screenshot"];

export type Args = {
  text?: string;
  ref?: string;
  x?: number;
  y?: number;
  submit?: boolean;
  name?: string;
  direction?: string;
  path?: string;
};

/** Runs one command. `exit` follows the iph contract: 0 ok, 1 not_sent, 2 unknown. */
export async function run(pilot: Pilot, command: Command, a: Args): Promise<{ result: unknown; exit: 0 | 1 | 2 }> {
  try {
    switch (command) {
      case "doctor": {
        const r = await pilot.doctor();
        return { result: r, exit: r.ready ? 0 : 1 };
      }
      case "snapshot":
        return { result: await pilot.snapshot(), exit: 0 };
      case "find":
        return { result: await pilot.find(need(a.text, "text")), exit: 0 };
      case "tap": {
        if (a.x !== undefined && a.y !== undefined) return outcome(await pilot.tap({ x: a.x, y: a.y }));
        return outcome(await pilot.tap(need(a.ref ?? a.text, "ref or text")));
      }
      case "type":
        return outcome(await pilot.type(need(a.text, "text"), { submit: a.submit }));
      case "key":
        return outcome(await pilot.key(need(a.name, "name")));
      case "swipe":
        return outcome(await pilot.swipe(need(a.direction, "direction") as Direction));
      case "scroll":
        return outcome(await pilot.scroll(need(a.direction, "direction") as "up" | "down"));
      case "home":
        return outcome(await pilot.home());
      case "screenshot":
        return outcome(await pilot.screenshot(a.path ?? join(tmpdir(), `iphone-pilot-${Date.now()}.png`)));
    }
  } catch (e) {
    if (e instanceof ReadError) return outcome(e.outcome);
    throw e;
  }
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined || v === "") throw new UsageError(`missing ${what}`);
  return v;
}

export class UsageError extends Error {}

function outcome(o: Outcome): { result: Outcome; exit: 0 | 1 | 2 } {
  return { result: o, exit: o.outcome === "done" ? (o.ok ? 0 : 1) : o.outcome === "unknown" ? 2 : 1 };
}
