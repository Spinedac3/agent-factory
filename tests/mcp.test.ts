import { describe, expect, it, vi } from "vitest";
import { openSession } from "../src/assistant/mcp.js";

const catalog = vi.hoisted(() => ({
  pages: {} as Record<string, { tools: Array<{ name: string }>; nextCursor?: string }>,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {}

    async listTools(params: { cursor?: string }) {
      return catalog.pages[params.cursor ?? ""];
    }

    async close() {}
  },
}));

/**
 * Builds a page of the catalog with tools of the given names
 *
 * @param   names       The tools' names
 * @param   nextCursor  Where the next page starts, if any
 *
 * @return  The page
 */
function page(names: string[], nextCursor?: string) {
  return {
    tools: names.map((name) => ({ name, inputSchema: { type: "object" } })),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

describe("the assistant's catalog over MCP", () => {
  it("reads every page of a long catalog", async () => {
    // Performs the test.
    catalog.pages = { "": page(["uno", "dos"], "p2"), p2: page(["tres"]) };
    const session = await openSession("http://assistant.test", "token");
    const tools = await session.tools();

    // Performs assertions.
    expect(tools.map((tool) => tool.name)).toEqual(["uno", "dos", "tres"]);
  });

  it("stops when the assistant hands the same page again", async () => {
    // Performs the test.
    catalog.pages = { "": page(["uno"], "p2"), p2: page(["dos"], "p2") };
    const session = await openSession("http://assistant.test", "token");

    // Performs assertions.
    await expect(session.tools()).rejects.toThrow("repite la misma página");
  });
});
