const U = process.env.METIS_MCP_URL;
const H = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

async function main() {
  const init = await fetch(U, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "probe", version: "1" },
      },
    }),
  });
  const sid = init.headers.get("mcp-session-id");
  await init.text();

  const h2 = { ...H, ...(sid ? { "mcp-session-id": sid } : {}) };
  await fetch(U, {
    method: "POST",
    headers: h2,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  const res = await fetch(U, {
    method: "POST",
    headers: h2,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  const body = await res.text();
  const line = body.split("\n").find((l) => l.startsWith("data: "));
  if (line === undefined) {
    console.log(body.slice(0, 400));
    return;
  }
  const tools = JSON.parse(line.slice(6)).result?.tools ?? [];
  console.log("TOOL COUNT:", tools.length);
  for (const t of tools) {
    console.log(" -", t.name);
  }
}

main().catch((e) => console.log("ERR", e.message));
