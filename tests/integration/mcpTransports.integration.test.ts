import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { RAWTRACE_SERVER_INSTRUCTIONS, createRawTraceMcpServer } from "../../src/server/mcpServer.js";
import { startHttpMcpServer } from "../../src/server/http.js";

const FULL_TOOL_NAMES = [
  "browser_launch",
  "browser_attach_cdp",
  "browser_navigate",
  "browser_reload",
  "browser_go_back",
  "browser_go_forward",
  "browser_close",
  "browser_list_tabs",
  "browser_new_tab",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_get_state",
  "browser_snapshot",
  "browser_get_dom",
  "browser_get_elements",
  "browser_optimize_selector",
  "browser_screenshot",
  "browser_screenshot_annotated",
  "browser_get_network",
  "browser_get_accessibility",
  "browser_eval",
  "browser_get_cookies",
  "browser_set_cookies",
  "browser_clear_cookies",
  "browser_get_storage",
  "browser_set_storage",
  "browser_export_storage_state",
  "browser_import_storage_state",
  "monitor_start",
  "monitor_stop",
  "monitor_list_sessions",
  "monitor_get_manifest",
  "monitor_get_summary",
  "monitor_read_events",
  "monitor_search_events",
  "monitor_search_bodies",
  "monitor_read_artifact",
  "monitor_export",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_hover",
  "browser_scroll",
  "browser_select_option",
  "browser_check",
  "browser_observe_action_result",
  "browser_wait_for_response",
  "browser_wait_for_response_body",
  "browser_upload_file",
  "browser_wait_for_download",
  "browser_get_downloads",
  "browser_set_viewport",
  "browser_grant_permissions",
  "browser_set_geolocation",
  "browser_get_forms",
  "browser_fill_form",
  "browser_handle_dialog",
  "browser_wait",
  "browser_poll_until"
] as const;

const AGENT_EXCLUDED_TOOL_NAMES = new Set([
  "browser_go_back",
  "browser_go_forward",
  "browser_list_tabs",
  "browser_new_tab",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_optimize_selector",
  "browser_screenshot_annotated",
  "browser_get_accessibility",
  "browser_eval",
  "browser_get_cookies",
  "browser_set_cookies",
  "browser_clear_cookies",
  "browser_get_storage",
  "browser_set_storage",
  "browser_export_storage_state",
  "browser_import_storage_state",
  "monitor_list_sessions",
  "monitor_get_manifest",
  "monitor_read_events",
  "browser_upload_file",
  "browser_set_viewport",
  "browser_grant_permissions",
  "browser_set_geolocation"
]);

const AGENT_TOOL_NAMES = FULL_TOOL_NAMES.filter((name) => !AGENT_EXCLUDED_TOOL_NAMES.has(name));

describe("MCP transports", () => {
  it("serves the unchanged full tool set and instructions over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/cli.js"]
    });
    const client = new Client({ name: "rawtrace-test-client", version: "0.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    const result = await client.callTool({ name: "monitor_start", arguments: {} });
    const instructions = client.getInstructions();
    await client.close();

    expect(instructions).toBe(RAWTRACE_SERVER_INSTRUCTIONS);
    expect(tools.tools.map((tool) => tool.name)).toEqual(FULL_TOOL_NAMES);
    expect(JSON.stringify(result)).toContain("RAW_CAPTURE_ACK_REQUIRED");

    for (const tool of tools.tools) {
      expect(tool.title).toEqual(expect.any(String));
      expect(tool.description).toContain("Use when ");
      expect(tool.description).toContain("Preconditions: ");
      expect(tool.description).toContain("Next: ");
      expect(tool.description).toContain("Sensitivity: ");
      expect(tool.outputSchema).toMatchObject({
        type: "object",
        properties: {
          ok: expect.any(Object),
          result: expect.any(Object),
          error: expect.any(Object)
        }
      });
      expect(tool.annotations).toMatchObject({
        title: tool.title,
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean)
      });
    }
  });

  it("serves the exact agent profile and instructions over streamable HTTP", async () => {
    const server = createRawTraceMcpServer(undefined, "agent");
    const http = await startHttpMcpServer(server, { host: "127.0.0.1", port: 0 });
    const client = new Client({ name: "rawtrace-http-test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
    const tools = await client.listTools();
    const result = await client.callTool({ name: "monitor_start", arguments: {} });
    const instructions = client.getInstructions();
    await client.close();
    await http.close();
    await server.close();

    expect(instructions).toBe(RAWTRACE_SERVER_INSTRUCTIONS);
    expect(tools.tools.map((tool) => tool.name)).toEqual(AGENT_TOOL_NAMES);
    expect(tools.tools).toHaveLength(35);
    expect(JSON.stringify(result)).toContain("RAW_CAPTURE_ACK_REQUIRED");
  });
});
