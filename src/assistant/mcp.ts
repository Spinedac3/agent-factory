import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolSchemas } from "../programs/contracts.js";
import type { ToolAnswer } from "../programs/run.js";

// A query over a large source takes a while; past this the call is stuck, not working
const CALL_TIMEOUT_MS = 10 * 60_000;

export interface AssistantSession {
  tools: () => Promise<ToolSchemas[]>;
  call: (tool: string, args: Record<string, unknown>) => Promise<ToolAnswer>;
  close: () => Promise<void>;
}

/**
 * Reads the error inside a failed result: the assistant wraps it as untrusted data, in JSON
 *
 * @param   content  The result's content blocks
 *
 * @return  The error code and message
 */
export function errorOf(content: unknown): { error: string; message: string } {
  const text = Array.isArray(content)
    ? content
        .map((block) =>
          (block as { type?: string; text?: string }).type === "text"
            ? (block as { text: string }).text
            : "",
        )
        .join("\n")
    : "";
  const json = text.replace(/^<tool_result[^>]*>\s*/, "").replace(/\s*<\/tool_result>\s*$/, "");
  try {
    const parsed = JSON.parse(json) as { error?: unknown; message?: unknown };
    return {
      error: typeof parsed.error === "string" ? parsed.error : "tool_failed",
      message: typeof parsed.message === "string" ? parsed.message : "la herramienta falló",
    };
  } catch {
    return { error: "tool_failed", message: json.slice(0, 300) || "la herramienta falló" };
  }
}

/**
 * Opens an MCP session with the assistant as one run, with its token
 *
 * @param   assistantUrl  The assistant's address
 * @param   token         The run's token
 *
 * @return  The session
 */
export async function openSession(assistantUrl: string, token: string): Promise<AssistantSession> {
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", assistantUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "agent-factory", version: "0.1.0" });
  await client.connect(transport);

  return {
    tools: async () => {
      const tools: ToolSchemas[] = [];
      // Every page: a long catalog comes in parts, and a server that repeats a cursor would
      // otherwise be asked forever
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        tools.push(
          ...page.tools.map((tool) => ({
            name: tool.name,
            inputSchema: tool.inputSchema as Record<string, unknown>,
            outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
          })),
        );
        cursor = page.nextCursor;
        if (cursor !== undefined && seen.has(cursor)) {
          throw new Error("El asistente repite la misma página del catálogo de herramientas");
        }
        if (cursor !== undefined) {
          seen.add(cursor);
        }
      } while (cursor);
      return tools;
    },
    call: async (tool, args) => {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      });
      if (result.isError === true) {
        return { ok: false, ...errorOf(result.content) };
      }
      // The structured result is the data as the tool returned it, never wrapped for a model
      return { ok: true, data: result.structuredContent ?? {} };
    },
    close: () => client.close(),
  };
}
