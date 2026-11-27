import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// The real `iphone-pilot mcp` command over stdio, as an MCP host starts it, with the fake iph on PATH.
const root = join(import.meta.dir, "..");
const fakeBin = join(import.meta.dir, "fixtures", "bin");

let dir: string;
let client: Client | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "iphone-pilot-mcp-"));
});

afterEach(async () => {
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function connect(mode: "auto" | "legacy"): Promise<Client> {
  client = new Client({ name: "test-host", version: "0" }, { versionNegotiation: { mode } });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "src", "cli.ts"), "--mode", "iph", "mcp"],
      env: { PATH: `${fakeBin}:${process.env.PATH}`, IPHONE_PILOT_STATE_DIR: dir, FAKE_IPH_LOG: join(dir, "iph.log") },
    }),
  );
  return client;
}

test("the server ships its drive-iphone skill over the skills extension on protocol 2026-07-28", async () => {
  const c = await connect("auto");
  expect(c.getNegotiatedProtocolVersion()).toBe("2026-07-28");
  const skills = new SkillsClient(c);
  const { skills: listed, invalid } = await skills.list();
  expect(invalid).toEqual([]);
  expect(listed.map((s) => s.frontmatter.name)).toEqual(["drive-iphone"]);

  // read() checks size, digest and frontmatter against the manifest, as a host does before loading it.
  const skillMd = await skills.read(listed[0]!);
  expect(skillMd.text).toBe(readFileSync(join(root, "skills", "drive-iphone", "SKILL.md"), "utf8"));
  expect((await skills.read(listed[0]!, "references/errors.md")).verified).toBe(true);
});

test("a host on the 2025 initialize handshake still gets the tools and their outcome JSON", async () => {
  const c = await connect("legacy");
  const res = await c.callTool({ name: "tap", arguments: { x: 100, y: 200 } });
  const [content] = res.content as { type: string; text: string }[];
  expect(JSON.parse(content!.text)).toMatchObject({ ok: true, outcome: "done" });
});
