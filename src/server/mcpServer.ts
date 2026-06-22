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
  registerTool(server, "browser_attach_cdp", "Attach to an existing Chromium CDP endpoint and select a tab by URL/title/pageId.", browserAttachCdpSchema, (input) =>
    runtime.browserAttachCdp(input)
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
  registerTool(server, "browser_snapshot", "Return a combined state/text/elements snapshot for the active page.", browserSnapshotSchema, (input) =>
    runtime.browserSnapshot(input)
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
  registerTool(server, "browser_screenshot_annotated", "Capture a screenshot with temporary visual bounding-box annotations.", browserScreenshotAnnotatedSchema, (input) =>
    runtime.browserScreenshotAnnotated(input)
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
  registerTool(server, "monitor_list_sessions", "List trace sessions created in this MCP process.", z.object({}), () =>
    runtime.monitorListSessions()
  );
  registerTool(server, "monitor_get_manifest", "Return a trace session manifest.", monitorGetManifestSchema, (input) =>
    runtime.monitorGetManifest(input)
  );
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
  registerTool(server, "monitor_read_artifact", "Read a raw trace artifact or body file from inside a trace directory.", monitorReadArtifactSchema, (input) =>
    runtime.monitorReadArtifact(input)
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
  registerTool(server, "browser_observe_action_result", "Capture before/after snapshots around an action and return a compact diff.", browserObserveActionResultSchema, (input) =>
    runtime.browserObserveActionResult(input)
  );
  registerTool(server, "browser_wait_for_response", "Wait for a network response matching filters.", browserWaitForResponseSchema, (input) =>
    runtime.browserWaitForResponse(input)
  );
  registerTool(server, "browser_wait_for_response_body", "Wait for a network response and read its raw body.", browserWaitForResponseBodySchema, (input) =>
    runtime.browserWaitForResponseBody(input)
  );
  registerTool(server, "browser_upload_file", "Upload local file(s) into a file input.", browserUploadFileSchema, (input) =>
    runtime.browserUploadFile(input)
  );
  registerTool(server, "browser_wait_for_download", "Wait for a page download and save it locally.", browserWaitForDownloadSchema, (input) =>
    runtime.browserWaitForDownload(input)
  );
  registerTool(server, "browser_get_downloads", "List downloads saved by this runtime.", browserGetDownloadsSchema, (input) =>
    runtime.browserGetDownloads(input)
  );
  registerTool(server, "browser_set_viewport", "Set active page viewport size.", browserSetViewportSchema, (input) =>
    runtime.browserSetViewport(input)
  );
  registerTool(server, "browser_grant_permissions", "Grant browser context permissions.", browserGrantPermissionsSchema, (input) =>
    runtime.browserGrantPermissions(input)
  );
  registerTool(server, "browser_set_geolocation", "Set browser context geolocation.", browserSetGeolocationSchema, (input) =>
    runtime.browserSetGeolocation(input)
  );
  registerTool(server, "browser_get_forms", "Inspect forms and form controls on the current page.", browserGetFormsSchema, (input) =>
    runtime.browserGetForms(input)
  );
  registerTool(server, "browser_fill_form", "Fill multiple form controls and optionally submit.", browserFillFormSchema, (input) =>
    runtime.browserFillForm(input)
  );
  registerTool(server, "browser_handle_dialog", "Configure JavaScript dialog handling.", browserHandleDialogSchema, (input) =>
    runtime.browserHandleDialog(input)
  );
  registerTool(server, "browser_wait", "Wait for a selector, URL, quiet period, or timeout.", browserWaitSchema, (input) =>
    runtime.browserWait(input)
  );
  registerTool(server, "browser_poll_until", "Poll page snapshots until text/url/selector/value/auth conditions match.", browserPollUntilSchema, (input) =>
    runtime.browserPollUntil(input)
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

const browserAttachCdpSchema = z.object({
  cdpUrl: z.string().url(),
  pageId: z.string().min(1).optional(),
  urlContains: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  targetIndex: z.number().int().min(0).optional(),
  activate: z.boolean().optional()
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

const fileAccessAcknowledgementSchema = z.object({
  acknowledgeFileAccess: z.boolean().optional()
});

const permissionChangeAcknowledgementSchema = z.object({
  acknowledgePermissionChange: z.boolean().optional()
});

const locationAccessAcknowledgementSchema = z.object({
  acknowledgeLocationAccess: z.boolean().optional()
});

const bodyRefSchema = z.object({
  path: z.string().min(1),
  byteLength: z.number().int().min(0),
  sha256: z.string().min(1),
  encoding: z.enum(["utf8", "base64", "binary"])
});

const browserGetStateSchema = rawAcknowledgementSchema;

const browserSnapshotSchema = rawAcknowledgementSchema.extend({
  selector: z.string().min(1).optional(),
  maxTextBytes: z.number().int().min(0).optional(),
  elementsLimit: z.number().int().min(1).optional(),
  includeInputs: z.boolean().optional(),
  includeLinks: z.boolean().optional()
});

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

const annotationBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().min(0),
  height: z.number().min(0),
  label: z.string().optional(),
  color: z.string().optional()
});

const browserScreenshotAnnotatedSchema = rawAcknowledgementSchema.extend({
  selector: z.string().min(1).optional(),
  selectors: z.array(z.string().min(1)).optional(),
  boxes: z.array(annotationBoxSchema).optional(),
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

const monitorGetManifestSchema = z.object({
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

const monitorReadArtifactSchema = rawAcknowledgementSchema.extend({
  sessionId: z.string().optional(),
  path: z.string().min(1).optional(),
  ref: bodyRefSchema.optional(),
  maxBytes: z.number().int().min(0).optional(),
  asText: z.boolean().optional(),
  parseJson: z.boolean().optional()
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

const pollConditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().min(1),
    selector: z.string().min(1).optional(),
    negate: z.boolean().optional()
  }),
  z.object({
    type: z.literal("url"),
    contains: z.string().min(1).optional(),
    equals: z.string().min(1).optional(),
    regex: z.string().min(1).optional(),
    negate: z.boolean().optional()
  }),
  z.object({
    type: z.literal("selector"),
    selector: z.string().min(1),
    state: z.enum(["attached", "visible", "hidden", "detached"]).optional(),
    negate: z.boolean().optional()
  }),
  z.object({
    type: z.literal("elementValue"),
    selector: z.string().min(1),
    value: z.string().optional(),
    contains: z.string().min(1).optional(),
    regex: z.string().min(1).optional(),
    negate: z.boolean().optional()
  }),
  z.object({
    type: z.literal("authSignal"),
    loggedInText: z.string().min(1).optional(),
    loggedOutText: z.string().min(1).optional(),
    loginUrlContains: z.string().min(1).optional(),
    loggedInUrlContains: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    negate: z.boolean().optional()
  })
]);

const browserPollUntilSchema = rawAcknowledgementSchema.extend({
  timeoutMs: z.number().int().positive().optional(),
  intervalMs: z.number().int().positive().optional(),
  match: z.enum(["all", "any"]).optional(),
  conditions: z.array(pollConditionSchema).min(1),
  snapshot: z
    .object({
      maxTextBytes: z.number().int().min(0).optional(),
      elementsLimit: z.number().int().min(1).optional(),
      includeInputs: z.boolean().optional(),
      includeLinks: z.boolean().optional()
    })
    .optional()
});

const browserWaitForResponseSchema = z.object({
  urlContains: z.string().min(1).optional(),
  urlRegex: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  status: z.number().int().min(100).max(999).optional(),
  timeoutMs: z.number().int().positive().optional()
});

const browserWaitForResponseBodySchema = rawAcknowledgementSchema.extend({
  urlContains: z.string().min(1).optional(),
  urlRegex: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  status: z.number().int().min(100).max(999).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxBytes: z.number().int().min(0).optional(),
  parseJson: z.boolean().optional()
});

const browserObserveActionSchema = z.discriminatedUnion("type", [
  browserClickSchema.extend({ type: z.literal("click") }),
  browserTypeSchema.extend({ type: z.literal("type") }),
  browserPressSchema.extend({ type: z.literal("press") }),
  browserCheckSchema.extend({ type: z.literal("check") }),
  browserSelectOptionSchema.extend({ type: z.literal("select") }),
  browserHoverSchema.extend({ type: z.literal("hover") }),
  browserScrollSchema.extend({ type: z.literal("scroll") }),
  browserReloadSchema.extend({ type: z.literal("reload") }),
  browserNavigateSchema.extend({ type: z.literal("navigate") }),
  browserEvalSchema.extend({ type: z.literal("eval") })
]);

const observeSnapshotOptionsSchema = z.object({
  selector: z.string().min(1).optional(),
  maxTextBytes: z.number().int().min(0).optional(),
  elementsLimit: z.number().int().min(1).optional(),
  includeInputs: z.boolean().optional(),
  includeLinks: z.boolean().optional()
});

const browserObserveActionResultSchema = dangerousEvalAcknowledgementSchema.extend({
  action: browserObserveActionSchema,
  beforeSnapshot: observeSnapshotOptionsSchema.optional(),
  afterSnapshot: observeSnapshotOptionsSchema.optional(),
  waitAfterMs: z.number().int().min(0).optional(),
  includeScreenshot: z.boolean().optional()
});

const browserUploadFileSchema = fileAccessAcknowledgementSchema.extend({
  selector: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().optional()
});

const browserWaitForDownloadSchema = rawAcknowledgementSchema.extend({
  triggerSelector: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  outputDir: z.string().min(1).optional(),
  suggestedFilename: z.string().min(1).optional()
});

const browserGetDownloadsSchema = z.object({
  limit: z.number().int().min(1).optional()
});

const browserSetViewportSchema = z.object({
  width: z.number().int().min(1),
  height: z.number().int().min(1)
});

const browserGrantPermissionsSchema = permissionChangeAcknowledgementSchema.extend({
  permissions: z.array(z.string().min(1)).min(1),
  origin: z.string().url().optional()
});

const browserSetGeolocationSchema = locationAccessAcknowledgementSchema.extend({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).optional()
});

const browserGetFormsSchema = rawAcknowledgementSchema.extend({
  selector: z.string().min(1).optional(),
  textContains: z.string().min(1).optional(),
  limit: z.number().int().min(1).optional(),
  maxBytes: z.number().int().min(0).optional()
});

const browserFillFormValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);

const browserFillFormFieldSchema = z
  .object({
    selector: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    placeholder: z.string().min(1).optional(),
    value: browserFillFormValueSchema.optional(),
    checked: z.boolean().optional()
  })
  .refine((field) => Boolean(field.selector || field.name || field.label || field.placeholder), {
    message: "Each form field requires selector, name, label, or placeholder."
  });

const browserFillFormSchema = z.object({
  fields: z.array(browserFillFormFieldSchema).min(1),
  submitSelector: z.string().min(1).optional(),
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
