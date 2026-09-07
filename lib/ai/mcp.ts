import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";

// The metis-router MCP gateway is the default tool discovery route: it already
// proxies the openharness harness/vector MCP (see metis-router/server/config.json),
// so it's always attempted first even if METIS_MCP_URL isn't explicitly set.
const GATEWAY_MCP_URL =
  process.env.METIS_MCP_URL ?? "http://metis-server:9999/mcp";

// Extra MCP servers to connect to directly, in addition to the gateway.
// Listed after the gateway so gateway tools win when both expose the same name.
const EXTRA_MCP_SERVER_URLS = [process.env.OPENHARNESS_MCP_URL].filter(
  (url): url is string => Boolean(url)
);

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
 * Connects to the metis-router MCP gateway (the default discovery route) plus any
 * extra directly-configured MCP servers, merging their tools. The gateway's tools
 * take precedence on name conflicts. Servers that fail to connect (or time out)
 * are skipped so chat still works.
 */
export async function connectMetisGateway(): Promise<McpSession> {
  const clients: MCPClient[] = [];
  let tools = {} as McpTools;

  await Promise.all(
    [...EXTRA_MCP_SERVER_URLS, GATEWAY_MCP_URL].map(async (url) => {
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
