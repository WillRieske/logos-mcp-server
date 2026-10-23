import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { makeFixtureDirs, cleanupFixtureDirs, type FixtureDirs } from "./helpers/fixtures.js";
import { startServer, callTool } from "./helpers/server.js";

// Only inputs the handler rejects before touching Logos: a running Logos
// would otherwise be driven for real.
describe("open_word_study over stdio", () => {
  let dirs: FixtureDirs;
  let client: Client;

  beforeAll(async () => {
    dirs = makeFixtureDirs();
    client = await startServer(dirs);
  }, 30_000);
  afterAll(async () => {
    await client.close();
    cleanupFixtureDirs(dirs);
  });

  async function call(args: Record<string, unknown>) {
    try {
      return await callTool(client, "open_word_study", args);
    } catch (e) {
      return { text: String(e), isError: true };
    }
  }

  // Design §3.9: consent comes only from the user, so the parameter list is pinned exactly.
  it("takes only a word, and warns that it uses the real keyboard", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "open_word_study");
    expect(tool).toBeDefined();
    expect(Object.keys((tool!.inputSchema as { properties: object }).properties)).toEqual(["word"]);
    expect(tool!.description).toContain("leave the PC alone");
    const props = (tool!.inputSchema as { properties: { word: { description: string } } }).properties;
    expect(props.word.description).toContain("prefix g: for Greek");
  });

  it.runIf(process.platform === "win32")("rejects a word that is empty or holds a line break before doing anything", async () => {
    expect(await call({ word: "   " })).toEqual({ text: "Give a word to study.", isError: true });
    const broken = await call({ word: "love\nGod" });
    expect(broken.isError).toBe(true);
    expect(broken.text).toContain("control character");
  });
});
