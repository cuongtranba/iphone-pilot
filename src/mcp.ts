import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { loadSkills } from "@modelcontextprotocol/server/ext/skills/node";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { type Args, type Command, run } from "./commands.ts";
import type { Pilot } from "./pilot.ts";

// Served through the MCP Skills extension, so a host gets the playbook for these tools from the
// server itself and it always matches the installed version.
const SKILLS_DIR = join(import.meta.dir, "..", "skills");

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
  // strict: a skill the catalog would skip fails startup instead of silently disappearing.
  const skills = await loadSkills(SKILLS_DIR, { strict: true });
  // serveStdio picks the protocol era from the client's opening message: 2026-07-28 (needed for
  // skills in hosts such as Claude Code) or a 2025 `initialize`, both from this one factory.
  serveStdio(() => {
    const server = new McpServer({ name: "iphone-pilot", version: "0.1.0" });
    for (const t of TOOLS) {
      server.registerTool(t.name, { description: t.description, inputSchema: z.object(t.shape) }, async (args: unknown) => {
        const { result } = await run(pilot, t.name, args as Args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      });
    }
    skills.attach(server);
    return server;
  });
}
