import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type Args, type Command, run } from "./commands.ts";
import type { Pilot } from "./pilot.ts";

const direction = z.enum(["up", "down", "left", "right"]);

const TOOLS: { name: Command; description: string; shape: z.ZodRawShape }[] = [
  { name: "doctor", description: "Check readiness of both modes (ocr, iph); each failed check has an exact user_action.", shape: {} },
  { name: "snapshot", description: "Read the phone screen as JSON elements (ref, role, label, frame). Replaces the stored refs.", shape: {} },
  { name: "find", description: "Elements whose label or value contains the text (case-insensitive). Replaces the stored refs.", shape: { text: z.string() } },
  {
    name: "tap",
    description: "Tap by ref (from the last snapshot), by text, or at x,y in the snapshot's screen coordinates. Stale refs, unknown text and ambiguous text are refused with not_sent.",
    shape: { ref: z.string().optional(), text: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
  },
  { name: "type", description: "Type text into the focused field; submit presses Return afterwards.", shape: { text: z.string(), submit: z.boolean().optional() } },
  { name: "key", description: "Press a key: return, escape, tab, delete, up, down, left, right, space.", shape: { name: z.string() } },
  { name: "swipe", description: "Swipe a finger up, down, left or right.", shape: { direction } },
  { name: "scroll", description: "Scroll to reveal content further down or up.", shape: { direction: z.enum(["up", "down"]) } },
  { name: "home", description: "Go to the Home Screen.", shape: {} },
  { name: "screenshot", description: "Save a PNG of the phone screen (fallback for icon-only screens). Returns the path.", shape: { path: z.string().optional() } },
];

export async function serve(pilot: Pilot): Promise<void> {
  const server = new McpServer({ name: "iphone-pilot", version: "0.1.0" });
  // The SDK's registerTool generics over zod shapes exceed tsc's instantiation depth for this
  // table-driven registration, so it is called through a minimal structural signature.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { description: string; inputSchema: z.ZodRawShape },
    cb: (args: unknown) => Promise<{ content: { type: "text"; text: string }[] }>,
  ) => unknown;
  for (const t of TOOLS) {
    register(t.name, { description: t.description, inputSchema: t.shape }, async (args) => {
      const { result } = await run(pilot, t.name, args as Args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
  }
  await server.connect(new StdioServerTransport());
}
