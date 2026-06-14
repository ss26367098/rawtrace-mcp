import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../constants.js";
import { asRawTraceError } from "../errors.js";
import { RawTraceRuntime } from "../runtime/browserRuntime.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

export function createRawTraceMcpServer(runtime = new RawTraceRuntime()): McpServer {
  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION
  });

  registerTool(server, "browser_launch", "Launch or connect to Chromium.", browserLaunchSchema, (input) =>
    runtime.browserLaunch(input)
  );
  registerTool(server, "browser_navigate", "Navigate the active page.", browserNavigateSchema, (input) =>
    runtime.browserNavigate(input)
  );
  registerTool(server, "browser_reload", "Reload the active page.", browserReloadSchema, (input) => runtime.browserReload(input));
  registerTool(server, "browser_go_back", "Go back in the active page history.", browserHistorySchema, (input) => runtime.browserGoBack(input));
  registerTool(server, "browser_go_forward", "Go forward in the active page history.", browserHistorySchema, (input) =>
    runtime.browserGoForward(input)
  );
  registerTool(server, "browser_close", "Close the active browser context.", z.object({}), () => runtime.browserClose());
  registerTool(server, "browser_list_tabs", "List open pages/tabs in the active browser context.", z.object({}), () => runtime.browserListTabs());
  registerTool(server, "browser_new_tab", "Open a new tab and make it active.", browserNewTabSchema, (input) => runtime.browserNewTab(input));
  registerTool(server, "browser_switch_tab", "Switch the active page/tab.", browserSwitchTabSchema, (input) => runtime.browserSwitchTab(input));
  registerTool(server, "browser_close_tab", "Close a page/tab.", browserCloseTabSchema, (input) => runtime.browserCloseTab(input));
  registerTool(server, "browser_get_state", "Inspect the current page URL, title, frames, viewport, and focused element.", browserGetStateSchema, (input) =>
    runtime.browserGetState(input)
  );
  registerTool(server, "browser_get_dom", "Inspect current page or selector DOM/text, externalizing large raw content.", browserGetDomSchema, (input) =>
    runtime.browserGetDom(input)
  );
  registerTool(server, "browser_get_elements", "Return summaries of interactive elements on the current page.", browserGetElementsSchema, (input) =>
    runtime.browserGetElements(input)
  );
  registerTool(server, "browser_optimize_selector", "Generate a shorter stable selector that uniquely matches the same target element.", browserOptimizeSelectorSchema, (input) =>
    runtime.browserOptimizeSelector(input)
  );
  registerTool(server, "browser_screenshot", "Capture a page or element screenshot to a local PNG file.", browserScreenshotSchema, (input) =>
    runtime.browserScreenshot(input)
  );
  registerTool(server, "browser_get_network", "Return recent network event summaries from the active/latest trace.", browserGetNetworkSchema, (input) =>
    runtime.browserGetNetwork(input)
  );
  registerTool(server, "browser_get_accessibility", "Return DOM-derived accessibility and role summaries.", browserGetAccessibilitySchema, (input) =>
    runtime.browserGetAccessibility(input)
  );
  registerTool(server, "browser_eval", "Execute arbitrary JavaScript in the active page or frame. Requires dangerous eval acknowledgment.", browserEvalSchema, (input) =>
    runtime.browserEval(input)
  );
  registerTool(server, "browser_get_cookies", "Read raw browser cookies. Requires credential access acknowledgment.", browserGetCookiesSchema, (input) =>
    runtime.browserGetCookies(input)
  );
  registerTool(server, "browser_set_cookies", "Set raw browser cookies. Requires credential access acknowledgment.", browserSetCookiesSchema, (input) =>
    runtime.browserSetCookies(input)
  );
  registerTool(server, "browser_clear_cookies", "Clear browser cookies. Requires credential access acknowledgment.", browserClearCookiesSchema, (input) =>
    runtime.browserClearCookies(input)
  );
  registerTool(server, "browser_get_storage", "Read localStorage/sessionStorage for the current origin. Requires credential access acknowledgment.", browserGetStorageSchema, (input) =>
    runtime.browserGetStorage(input)
  );
  registerTool(server, "browser_set_storage", "Set localStorage/sessionStorage for the current origin. Requires credential access acknowledgment.", browserSetStorageSchema, (input) =>
    runtime.browserSetStorage(input)
  );
  registerTool(server, "browser_export_storage_state", "Export Playwright storageState. Requires credential access acknowledgment.", browserExportStorageStateSchema, (input) =>
    runtime.browserExportStorageState(input)
  );
  registerTool(server, "browser_import_storage_state", "Import Playwright storageState into the active context. Requires credential access acknowledgment.", browserImportStorageStateSchema, (input) =>
    runtime.browserImportStorageState(input)
  );
  registerTool(server, "monitor_start", "Start raw event capture. Requires acknowledgeRawCapture: true.", monitorStartSchema, (input) =>
    runtime.monitorStart(input)
  );
  registerTool(server, "monitor_stop", "Stop raw event capture and flush trace files.", z.object({}), () => runtime.monitorStop());
  registerTool(server, "monitor_get_summary", "Return a compact AI-readable trace summary.", monitorSummarySchema, (input) =>
    runtime.monitorGetSummary(input)
  );
  registerTool(server, "monitor_read_events", "Read trace events in chunks.", monitorReadEventsSchema, (input) =>
    runtime.monitorReadEvents(input)
  );
  registerTool(server, "monitor_search_events", "Search trace events without returning full streams.", monitorSearchEventsSchema, (input) =>
    runtime.monitorSearchEvents(input)
  );
  registerTool(server, "monitor_search_bodies", "Search raw request and response body files by text.", monitorSearchBodiesSchema, (input) =>
    runtime.monitorSearchBodies(input)
  );
  registerTool(server, "monitor_export", "Export a trace bundle.", monitorExportSchema, (input) => runtime.monitorExport(input));
  registerTool(server, "browser_click", "Click an element.", browserClickSchema, (input) => runtime.browserClick(input));
  registerTool(server, "browser_type", "Type text into an element.", browserTypeSchema, (input) => runtime.browserType(input));
  registerTool(server, "browser_press", "Press a keyboard key, optionally after focusing a selector.", browserPressSchema, (input) =>
    runtime.browserPress(input)
  );
  registerTool(server, "browser_hover", "Hover over an element.", browserHoverSchema, (input) => runtime.browserHover(input));
  registerTool(server, "browser_scroll", "Scroll the active page or an element region.", browserScrollSchema, (input) =>
    runtime.browserScroll(input)
  );
  registerTool(server, "browser_select_option", "Select option values from a select element.", browserSelectOptionSchema, (input) =>
    runtime.browserSelectOption(input)
  );
  registerTool(server, "browser_check", "Check or uncheck a checkbox/radio element.", browserCheckSchema, (input) => runtime.browserCheck(input));
  registerTool(server, "browser_wait_for_response", "Wait for a network response matching filters.", browserWaitForResponseSchema, (input) =>
    runtime.browserWaitForResponse(input)
  );
  registerTool(server, "browser_handle_dialog", "Configure JavaScript dialog handling.", browserHandleDialogSchema, (input) =>
    runtime.browserHandleDialog(input)
  );
  registerTool(server, "browser_wait", "Wait for a selector, URL, quiet period, or timeout.", browserWaitSchema, (input) =>
    runtime.browserWait(input)
  );

  return server;
}

function registerTool<T extends z.ZodType>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: T,
  handler: (input: z.output<T>) => Promise<unknown>
): void {
  const register = server.registerTool.bind(server) as (
    toolName: string,
    config: { description: string; inputSchema: T },
    callback: (input: unknown) => Promise<ToolResult>
  ) => void;

  register(
    name,
    {
      description,
      inputSchema
    },
    async (input: unknown) => {
      try {
        const result = await handler(inputSchema.parse(input));
        return jsonToolResult({
          ok: true,
          result
        });
      } catch (error) {
        const rawTraceError = asRawTraceError(error);
        return jsonToolResult(
          {
            ok: false,
            error: {
              code: rawTraceError.code,
              message: rawTraceError.message,
              details: rawTraceError.details
            }
          },
          true
        );
      }
    }
  );
}

function jsonToolResult(value: unknown, isError = false): ToolResult {
  return {
    isError,
    structuredContent: value,
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

const browserLaunchSchema = z.object({
  headless: z.boolean().optional(),
  userDataDir: z.string().optional(),
  cdpUrl: z.string().url().optional(),
  storageStatePath: z.string().min(1).optional(),
  acknowledgeRawCapture: z.boolean().optional(),
  acknowledgeCredentialAccess: z.boolean().optional(),
  acknowledgeStorageStateOverwrite: z.boolean().optional()
});

const browserNavigateSchema = z.object({
  url: z.string().url(),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional()
});

const waitUntilSchema = z.enum(["load", "domcontentloaded", "networkidle", "commit"]);

const browserReloadSchema = z.object({
  waitUntil: waitUntilSchema.optional(),
  timeoutMs: z.number().int().positive().optional()
});

const browserHistorySchema = z.object({
  waitUntil: waitUntilSchema.optional(),
  timeoutMs: z.number().int().positive().optional()
});

const browserNewTabSchema = z.object({
  url: z.string().url().optional(),
  waitUntil: waitUntilSchema.optional()
});

const browserSwitchTabSchema = z.object({
  pageId: z.string().min(1)
});

const browserCloseTabSchema = z.object({
  pageId: z.string().min(1).optional()
});

const rawAcknowledgementSchema = z.object({
  acknowledgeRawCapture: z.boolean().optional()
});

const dangerousEvalAcknowledgementSchema = rawAcknowledgementSchema.extend({
  acknowledgeDangerousEval: z.boolean().optional()
});

const credentialAccessAcknowledgementSchema = rawAcknowledgementSchema.extend({
  acknowledgeCredentialAccess: z.boolean().optional()
});

const browserGetStateSchema = rawAcknowledgementSchema;

const browserGetDomSchema = rawAcknowledgementSchema.extend({
  selector: z.string().min(1).optional(),
  mode: z.enum(["html", "text", "both"]).optional(),
  maxBytes: z.number().int().min(0).optional()
});

const browserGetElementsSchema = rawAcknowledgementSchema.extend({
  selector: z.string().min(1).optional(),
  textContains: z.string().min(1).optional(),
  limit: z.number().int().min(1).optional()
});

const browserOptimizeSelectorSchema = rawAcknowledgementSchema.extend({
  selector: z.string().min(1),
  targetIndex: z.number().int().min(0).optional(),
  textContains: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  candidateLimit: z.number().int().min(1).max(100).optional(),
  includeRejected: z.boolean().optional()
});

const browserScreenshotSchema = rawAcknowledgementSchema.extend({
  selector: z.string().min(1).optional(),
  fullPage: z.boolean().optional(),
  outputPath: z.string().min(1).optional()
});

const browserGetNetworkSchema = z.object({
  sessionId: z.string().optional(),
  urlContains: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  status: z.number().int().min(100).max(999).optional(),
  sinceSeq: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional()
});

const browserGetAccessibilitySchema = rawAcknowledgementSchema.extend({
  selector: z.string().min(1).optional(),
  textContains: z.string().min(1).optional(),
  limit: z.number().int().min(1).optional()
});

const browserEvalSchema = dangerousEvalAcknowledgementSchema.extend({
  expression: z.string().min(1),
  arg: z.unknown().optional(),
  frameUrlContains: z.string().min(1).optional(),
  frameName: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxBytes: z.number().int().min(0).optional()
});

const browserGetCookiesSchema = credentialAccessAcknowledgementSchema.extend({
  urls: z.array(z.string().url()).optional()
});

const cookieSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    url: z.string().url().optional(),
    domain: z.string().optional(),
    path: z.string().optional(),
    expires: z.number().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional()
  })
  .passthrough();

const browserSetCookiesSchema = credentialAccessAcknowledgementSchema.extend({
  cookies: z.array(cookieSchema).min(1)
});

const browserClearCookiesSchema = credentialAccessAcknowledgementSchema.extend({
  name: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  path: z.string().min(1).optional()
});

const nullableStringRecordSchema = z.record(z.string(), z.string().nullable());

const browserGetStorageSchema = credentialAccessAcknowledgementSchema.extend({
  origin: z.string().url().optional(),
  includeSessionStorage: z.boolean().optional(),
  maxBytes: z.number().int().min(0).optional()
});

const browserSetStorageSchema = credentialAccessAcknowledgementSchema.extend({
  origin: z.string().url().optional(),
  localStorage: nullableStringRecordSchema.optional(),
  sessionStorage: nullableStringRecordSchema.optional()
});

const browserExportStorageStateSchema = credentialAccessAcknowledgementSchema.extend({
  outputPath: z.string().min(1).optional(),
  indexedDB: z.boolean().optional(),
  maxBytes: z.number().int().min(0).optional()
});

const browserImportStorageStateSchema = credentialAccessAcknowledgementSchema.extend({
  path: z.string().min(1),
  acknowledgeStorageStateOverwrite: z.boolean().optional()
});

const monitorStartSchema = z.object({
  acknowledgeRawCapture: z.boolean().optional(),
  captureDom: z.boolean().optional(),
  captureNetwork: z.boolean().optional(),
  captureCookies: z.boolean().optional(),
  captureBodies: z.boolean().optional(),
  captureWebSockets: z.boolean().optional(),
  captureConsole: z.boolean().optional(),
  captureFrames: z.boolean().optional(),
  maxBodyBytes: z.number().int().positive().optional(),
  outputDir: z.string().optional()
});

const monitorSummarySchema = z.object({
  sessionId: z.string().optional()
});

const eventStreamSchema = z.enum(["actions", "dom", "network", "cookies", "websocket", "console", "frames", "all"]);

const monitorReadEventsSchema = z.object({
  sessionId: z.string().optional(),
  stream: eventStreamSchema,
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional()
});

const monitorSearchEventsSchema = z.object({
  sessionId: z.string().optional(),
  stream: eventStreamSchema.optional(),
  text: z.string().min(1).optional(),
  urlContains: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  sinceSeq: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional()
});

const monitorSearchBodiesSchema = rawAcknowledgementSchema.extend({
  sessionId: z.string().optional(),
  text: z.string().min(1),
  urlContains: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  status: z.number().int().min(100).max(999).optional(),
  sinceSeq: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional()
});

const monitorExportSchema = z.object({
  sessionId: z.string().optional(),
  format: z.literal("zip").optional(),
  outputPath: z.string().optional()
});

const browserClickSchema = z.object({
  selector: z.string().min(1),
  timeoutMs: z.number().int().positive().optional()
});

const browserTypeSchema = z.object({
  selector: z.string().min(1),
  text: z.string(),
  delayMs: z.number().int().min(0).optional(),
  timeoutMs: z.number().int().positive().optional()
});

const browserPressSchema = z.object({
  key: z.string().min(1),
  selector: z.string().min(1).optional(),
  delayMs: z.number().int().min(0).optional(),
  timeoutMs: z.number().int().positive().optional()
});

const browserHoverSchema = z.object({
  selector: z.string().min(1),
  timeoutMs: z.number().int().positive().optional()
});

const browserScrollSchema = z.object({
  selector: z.string().min(1).optional(),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
  timeoutMs: z.number().int().positive().optional()
});

const selectOptionValueSchema = z.union([
  z.string(),
  z.object({
    value: z.string().optional(),
    label: z.string().optional(),
    index: z.number().int().min(0).optional()
  })
]);

const browserSelectOptionSchema = z.object({
  selector: z.string().min(1),
  values: z.union([selectOptionValueSchema, z.array(selectOptionValueSchema).min(1)]),
  timeoutMs: z.number().int().positive().optional()
});

const browserCheckSchema = z.object({
  selector: z.string().min(1),
  checked: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional()
});

const browserWaitForResponseSchema = z.object({
  urlContains: z.string().min(1).optional(),
  urlRegex: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  status: z.number().int().min(100).max(999).optional(),
  timeoutMs: z.number().int().positive().optional()
});

const browserHandleDialogSchema = z.object({
  action: z.enum(["accept", "dismiss"]),
  promptText: z.string().optional(),
  once: z.boolean().optional()
});

const browserWaitSchema = z.object({
  mode: z.enum(["quiet", "selector", "url", "timeout"]),
  quietMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  selector: z.string().optional(),
  pattern: z.string().optional(),
  delayMs: z.number().int().min(0).optional()
});
