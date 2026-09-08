import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";

const GATEWAY_MCP_URL =
  process.env.METIS_MCP_URL ?? "http://metis-server:9999/mcp";

type McpTools = Awaited<ReturnType<MCPClient["tools"]>>;

type McpSession = {
  close: () => Promise<void>;
  tools: McpTools;
};

// A hung gateway (no response, no rejection) would otherwise block the whole
// chat request forever since createMCPClient/tools() have no built-in timeout.
const MCP_CONNECT_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms}ms connecting to ${label}`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * All MCP tool access (OpenHarness, MAF, or generic MCP mode) is routed through
 * metis-router. It's the single gateway that aggregates every downstream MCP
 * server (openharness, videobrain, morphazoid, etc.) with namespaced tool names,
 * so tool availability stays consistent across agent modes and chat turns.
 */
export async function connectMcpTools(): Promise<McpSession> {
  const clients: MCPClient[] = [];
  let tools = {} as McpTools;
  const urls = [GATEWAY_MCP_URL];

  await Promise.all(
    urls.map(async (url) => {
      try {
        const client = await withTimeout(
          createMCPClient({ transport: { type: "http", url } }),
          MCP_CONNECT_TIMEOUT_MS,
          url
        );
        const clientTools = await withTimeout(
          client.tools(),
          MCP_CONNECT_TIMEOUT_MS,
          url
        );
        clients.push(client);
        tools = { ...tools, ...clientTools };
      } catch (error) {
        console.error(`Failed to connect to MCP server ${url}:`, error);
      }
    })
  );

  return {
    close: async () => {
      await Promise.all(clients.map((client) => client.close()));
    },
    tools,
  };
}
