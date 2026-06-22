import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createRawTraceMcpServer } from "../../src/server/mcpServer.js";
import { startHttpMcpServer } from "../../src/server/http.js";

describe("MCP transports", () => {
  it("serves tools over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/cli.js"]
    });
    const client = new Client({ name: "rawtrace-test-client", version: "0.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    const result = await client.callTool({ name: "monitor_start", arguments: {} });
    await client.close();
    expect(tools.tools).toHaveLength(59);
    expect(tools.tools.map((tool) => tool.name)).toContain("monitor_read_artifact");
    expect(tools.tools.map((tool) => tool.name)).toContain("browser_fill_form");
    expect(tools.tools.map((tool) => tool.name)).toContain("browser_snapshot");
    expect(tools.tools.map((tool) => tool.name)).toContain("browser_poll_until");
    expect(JSON.stringify(result)).toContain("RAW_CAPTURE_ACK_REQUIRED");
  });

  it("serves tools over streamable HTTP", async () => {
    const server = createRawTraceMcpServer();
    const http = await startHttpMcpServer(server, { host: "127.0.0.1", port: 0 });
    const client = new Client({ name: "rawtrace-http-test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
    const tools = await client.listTools();
    const result = await client.callTool({ name: "monitor_start", arguments: {} });
    await client.close();
    await http.close();
    await server.close();
    expect(tools.tools).toHaveLength(59);
    expect(tools.tools.map((tool) => tool.name)).toContain("browser_wait_for_response_body");
    expect(tools.tools.map((tool) => tool.name)).toContain("browser_wait_for_download");
    expect(tools.tools.map((tool) => tool.name)).toContain("browser_attach_cdp");
    expect(tools.tools.map((tool) => tool.name)).toContain("browser_screenshot_annotated");
    expect(JSON.stringify(result)).toContain("RAW_CAPTURE_ACK_REQUIRED");
  });
});
