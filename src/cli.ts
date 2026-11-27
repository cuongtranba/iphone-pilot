#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { COMMANDS, type Command, UsageError, run } from "./commands.ts";
import { createPilot } from "./pilot.ts";
import type { Mode } from "./model.ts";

const USAGE = `usage: iphone-pilot [--mode auto|ocr|iph] [--image file.png] <command>
  doctor                      readiness of both modes, with exact fixes
  snapshot                    elements on screen as JSON (refs e1..eN)
  find <text>                 elements whose label/value contains text
  tap <ref|text|x,y>          tap by ref from the last snapshot, by text, or at a point
  type <text> [--submit]      type text (Return after it with --submit)
  key <return|escape|tab|delete|up|down|left|right|space>
  swipe <up|down|left|right>
  scroll <up|down>
  home
  screenshot <file.png>
  mcp                         stdio MCP server (mode fixed at start)
exit codes: 0 ok, 1 not_sent, 2 unknown (input may have gone out)`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    mode: { type: "string", default: "auto" },
    image: { type: "string" },
    submit: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

function fail(msg: string): never {
  console.error(`iphone-pilot: ${msg}\n${USAGE}`);
  process.exit(64);
}

const [command, ...rest] = positionals;
if (values.help || !command) fail("");
if (!["auto", "ocr", "iph"].includes(values.mode)) fail(`unknown mode ${values.mode}`);

const pilot = createPilot({ mode: values.mode as Mode | "auto", image: values.image });

if (command === "mcp") {
  const { serve } = await import("./mcp.ts");
  await serve(pilot);
} else {
  if (!(COMMANDS as string[]).includes(command)) fail(`unknown command ${command}`);
  const arg = rest.join(" ");
  const point = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(arg);
  try {
    const { result, exit } = await run(pilot, command as Command, {
      text: arg || undefined,
      ref: arg || undefined,
      ...(command === "tap" && point ? { x: Number(point[1]), y: Number(point[2]) } : {}),
      submit: values.submit,
      name: arg || undefined,
      direction: arg || undefined,
      path: arg || undefined,
    });
    console.log(JSON.stringify(result));
    process.exit(exit);
  } catch (e) {
    if (e instanceof UsageError) fail(e.message);
    throw e;
  }
}
