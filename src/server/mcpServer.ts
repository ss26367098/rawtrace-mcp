import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../constants.js";
import { asRawTraceError } from "../errors.js";
import { RawTraceRuntime } from "../runtime/browserRuntime.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export const RAWTRACE_SERVER_INSTRUCTIONS =
  "Proactively use RawTrace only for flaky or timing-sensitive browser behavior: Playwright/Cypress failures, transient DOM, network or WebSocket races, redirects, or unclear clicks. For one action use browser_observe_action_result. For multi-step issues: monitor_start, reproduce, monitor_stop, monitor_get_summary, targeted monitor_search_events/monitor_search_bodies, then monitor_read_artifact. In authorized dev/test work pass acknowledgeRawCapture: true without asking; ask only if authorization is unclear. Treat trace output as sensitive. Start normal traces without cookies or bodies unless authentication, cookies, or request/response content is relevant.";

export const TOOL_PROFILES = ["full", "agent"] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  annotations: ToolAnnotations;
  profiles: readonly ToolProfile[];
  handler: (input: unknown) => Promise<unknown>;
};

const toolOutputSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional()
    })
    .optional()
});

export function createRawTraceMcpServer(runtime = new RawTraceRuntime(), toolProfile: ToolProfile = "full"): McpServer {
  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION
    },
    {
      instructions: RAWTRACE_SERVER_INSTRUCTIONS
    }
  );

  for (const definition of createToolCatalog(runtime)) {
    if (definition.profiles.includes(toolProfile)) {
      registerTool(server, definition);
    }
  }

  return server;
}

function registerTool(server: McpServer, definition: ToolDefinition): void {
  const register = server.registerTool.bind(server) as (
    toolName: string,
    config: {
      title: string;
      description: string;
      inputSchema: z.ZodType;
      outputSchema: typeof toolOutputSchema;
      annotations: ToolAnnotations;
    },
    callback: (input: unknown) => Promise<ToolResult>
  ) => void;

  register(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: toolOutputSchema,
      annotations: {
        ...definition.annotations,
        title: definition.title
      }
    },
    async (input: unknown) => {
      try {
        const result = await definition.handler(definition.inputSchema.parse(input));
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

function jsonToolResult(value: Record<string, unknown>, isError = false): ToolResult {
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

const AGENT_PROFILES: readonly ToolProfile[] = ["full", "agent"];
const FULL_PROFILE: readonly ToolProfile[] = ["full"];

const ANNOTATIONS = {
  browserRead: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  },
  browserWrite: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true
  },
  browserAction: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true
  },
  localRead: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  localWrite: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  }
} as const satisfies Record<string, ToolAnnotations>;

function createToolCatalog(runtime: RawTraceRuntime): ToolDefinition[] {
  return [
    defineTool({
      name: "browser_launch",
      title: "Launch Browser",
      description: describeTool(
        "a RawTrace-controlled Chromium session is not running yet, or a known CDP endpoint or storage state must be opened before reproducing a browser issue",
        "provide only profiles and systems you are authorized to inspect; storageState use also requires the raw-capture and credential acknowledgements",
        "navigate or inspect the selected page, then use browser_observe_action_result for one action or monitor_start for a multi-step reproduction",
        "launch options can expose an existing browser profile, CDP session, or credential-bearing storage state"
      ),
      inputSchema: browserLaunchSchema,
      annotations: ANNOTATIONS.browserWrite,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserLaunch(input)
    }),
    defineTool({
      name: "browser_attach_cdp",
      title: "Attach to Chromium",
      description: describeTool(
        "an already-running Chromium instance contains the page that must be diagnosed and a tab needs to be selected by page ID, URL, title, or index",
        "the CDP endpoint and target browser must be explicitly authorized and reachable",
        "confirm the selected page with browser_get_state, then observe one action or start a multi-step trace",
        "attaching exposes the live browser context and any data visible in the selected tab"
      ),
      inputSchema: browserAttachCdpSchema,
      annotations: ANNOTATIONS.browserWrite,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserAttachCdp(input)
    }),
    defineTool({
      name: "browser_navigate",
      title: "Navigate Page",
      description: describeTool(
        "the active page must open an exact URL as part of a reproduction, redirect investigation, authentication flow, or network-timing diagnosis",
        "a browser must be active and the destination must be within the authorized development or test scope",
        "inspect state or begin the action sequence; use monitor_get_summary after stopping any active trace",
        "navigation contacts an external origin and may send cookies or other browser credentials"
      ),
      inputSchema: browserNavigateSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserNavigate(input)
    }),
    defineTool({
      name: "browser_reload",
      title: "Reload Page",
      description: describeTool(
        "a reload is necessary to reproduce initialization races, cached-versus-fresh behavior, redirects, or intermittent requests",
        "an active page is required; start monitor_start first when the whole reload sequence matters",
        "inspect the resulting state or stop the trace and read its summary",
        "reload can repeat writes or requests performed by the page and may transmit active credentials"
      ),
      inputSchema: browserReloadSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserReload(input)
    }),
    defineTool({
      name: "browser_go_back",
      title: "Go Back",
      description: describeTool(
        "history navigation is specifically needed to reproduce a redirect, back-button state bug, or single-page application history issue",
        "an active page with a previous history entry is required",
        "inspect state and relevant network events after navigation",
        "history navigation can reissue requests and expose credential-bearing page state"
      ),
      inputSchema: browserHistorySchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserGoBack(input)
    }),
    defineTool({
      name: "browser_go_forward",
      title: "Go Forward",
      description: describeTool(
        "forward history navigation is specifically required to reproduce a cached state, redirect, or single-page application history issue",
        "an active page with a forward history entry is required",
        "inspect state and relevant network events after navigation",
        "history navigation can reissue requests and expose credential-bearing page state"
      ),
      inputSchema: browserHistorySchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserGoForward(input)
    }),
    defineTool({
      name: "browser_close",
      title: "Close Browser",
      description: describeTool(
        "the RawTrace browser context is no longer needed or must be reset before a clean reproduction",
        "stop an active monitor first when its trace must be flushed and retained",
        "launch or attach again only if more browser work is required",
        "closing destroys the in-memory browser context and can discard unsaved page state"
      ),
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.browserAction,
      profiles: AGENT_PROFILES,
      handler: () => runtime.browserClose()
    }),
    defineTool({
      name: "browser_list_tabs",
      title: "List Browser Tabs",
      description: describeTool(
        "a full-profile workflow must discover the open pages before switching, closing, or selecting a CDP target",
        "an active browser context is required",
        "use browser_switch_tab with the chosen page ID",
        "tab URLs and titles may reveal private application or account information"
      ),
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.browserRead,
      profiles: FULL_PROFILE,
      handler: () => runtime.browserListTabs()
    }),
    defineTool({
      name: "browser_new_tab",
      title: "Open New Tab",
      description: describeTool(
        "a full-profile reproduction genuinely requires a separate page rather than the existing active tab",
        "an active browser context is required and any supplied URL must be authorized",
        "inspect or trace the new active tab, then close it when finished",
        "opening a URL contacts an external origin and may send context credentials"
      ),
      inputSchema: browserNewTabSchema,
      annotations: ANNOTATIONS.browserWrite,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserNewTab(input)
    }),
    defineTool({
      name: "browser_switch_tab",
      title: "Switch Browser Tab",
      description: describeTool(
        "a full-profile workflow must make a previously discovered page the active target",
        "obtain a valid page ID from browser_list_tabs or browser_attach_cdp",
        "confirm selection with browser_get_state before acting",
        "the selected tab may contain private content or an authenticated session"
      ),
      inputSchema: browserSwitchTabSchema,
      annotations: ANNOTATIONS.browserWrite,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserSwitchTab(input)
    }),
    defineTool({
      name: "browser_close_tab",
      title: "Close Browser Tab",
      description: describeTool(
        "a full-profile workflow must remove an unneeded page or recover from a page-specific failure",
        "identify the intended page and stop any trace that must retain its final events",
        "list tabs or inspect state to confirm which page remains active",
        "closing a tab discards its unsaved in-memory state"
      ),
      inputSchema: browserCloseTabSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserCloseTab(input)
    }),
    defineTool({
      name: "browser_get_state",
      title: "Get Page State",
      description: describeTool(
        "the current URL, title, frames, viewport, or focused element is needed to orient a browser diagnosis",
        "an active page and acknowledgeRawCapture: true are required in an authorized environment",
        "use browser_snapshot for richer page context or choose the next targeted action",
        "state can expose URLs, frame metadata, and focused values from the live page"
      ),
      inputSchema: browserGetStateSchema,
      annotations: ANNOTATIONS.browserRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserGetState(input)
    }),
    defineTool({
      name: "browser_snapshot",
      title: "Snapshot Page",
      description: describeTool(
        "a compact combined view of page state, text, inputs, links, and interactive elements is more useful than separate inspection calls",
        "an active page and acknowledgeRawCapture: true are required",
        "select a target for browser_observe_action_result or compare with a later snapshot",
        "snapshots may include DOM text, visible input values, links, and externalized raw artifacts"
      ),
      inputSchema: browserSnapshotSchema,
      annotations: ANNOTATIONS.browserRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserSnapshot(input)
    }),
    defineTool({
      name: "browser_get_dom",
      title: "Inspect DOM",
      description: describeTool(
        "current HTML or text for a page region is needed to understand transient DOM state, hidden content, or selector behavior",
        "an active page and acknowledgeRawCapture: true are required; narrow with a selector when possible",
        "use browser_get_elements for actionable targets or compare DOM mutations in a trace",
        "raw DOM and text may contain secrets, personal data, hidden form values, or externalized artifacts"
      ),
      inputSchema: browserGetDomSchema,
      annotations: ANNOTATIONS.browserRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserGetDom(input)
    }),
    defineTool({
      name: "browser_get_elements",
      title: "List Interactive Elements",
      description: describeTool(
        "stable selectors and concise metadata for clickable, editable, or otherwise interactive elements are needed before an action",
        "an active page and acknowledgeRawCapture: true are required; filter by selector or text on large pages",
        "call browser_observe_action_result with the chosen selector for a single uncertain interaction",
        "element summaries can include visible text, attributes, values, and other raw page metadata"
      ),
      inputSchema: browserGetElementsSchema,
      annotations: ANNOTATIONS.browserRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserGetElements(input)
    }),
    defineTool({
      name: "browser_optimize_selector",
      title: "Optimize Selector",
      description: describeTool(
        "a full-profile workflow needs a shorter unique selector for a target that is already known",
        "an active page, acknowledgeRawCapture: true, and a selector matching the intended element are required",
        "verify the returned selector with browser_get_elements before relying on it in automation",
        "candidate analysis reads DOM attributes and text that may be sensitive"
      ),
      inputSchema: browserOptimizeSelectorSchema,
      annotations: ANNOTATIONS.browserRead,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserOptimizeSelector(input)
    }),
    defineTool({
      name: "browser_screenshot",
      title: "Capture Screenshot",
      description: describeTool(
        "visual evidence is necessary to understand layout, overlays, rendering, or the result of a browser interaction",
        "an active page and acknowledgeRawCapture: true are required; select a region when the full page is unnecessary",
        "use the saved PNG as supporting evidence and continue with targeted DOM or trace inspection",
        "screenshots may capture personal data, secrets, account state, or other sensitive pixels and are written locally"
      ),
      inputSchema: browserScreenshotSchema,
      annotations: ANNOTATIONS.browserWrite,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserScreenshot(input)
    }),
    defineTool({
      name: "browser_screenshot_annotated",
      title: "Capture Annotated Screenshot",
      description: describeTool(
        "a full-profile visual diagnosis needs temporary selector or coordinate annotations over the page",
        "an active page and acknowledgeRawCapture: true are required; annotations must identify authorized content",
        "inspect the saved PNG and use normal DOM tools for machine-readable details",
        "the image and labels may expose sensitive page content and are written locally"
      ),
      inputSchema: browserScreenshotAnnotatedSchema,
      annotations: ANNOTATIONS.browserWrite,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserScreenshotAnnotated(input)
    }),
    defineTool({
      name: "browser_get_network",
      title: "Get Recent Network Events",
      description: describeTool(
        "recent request and response summaries are needed to explain a click with no request, wrong endpoint, status failure, redirect, or timing issue",
        "a trace session must exist; filter by URL, method, status, or sequence when possible",
        "use monitor_search_events for cross-stream correlation or monitor_search_bodies only when body content is relevant",
        "network summaries can expose URLs, headers, status details, and references to sensitive bodies"
      ),
      inputSchema: browserGetNetworkSchema,
      annotations: ANNOTATIONS.localRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserGetNetwork(input)
    }),
    defineTool({
      name: "browser_get_accessibility",
      title: "Inspect Accessibility",
      description: describeTool(
        "a full-profile diagnosis specifically needs DOM-derived roles, names, states, or accessibility-oriented element summaries",
        "an active page and acknowledgeRawCapture: true are required",
        "use the returned selector and role context in a targeted action or source fix",
        "accessible names and values are derived from raw DOM and may contain sensitive content"
      ),
      inputSchema: browserGetAccessibilitySchema,
      annotations: ANNOTATIONS.browserRead,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserGetAccessibility(input)
    }),
    defineTool({
      name: "browser_eval",
      title: "Evaluate Page JavaScript",
      description: describeTool(
        "a full-profile diagnosis cannot be completed with safe DOM, action, wait, or trace tools and exact page-side JavaScript is essential",
        "an active authorized page plus acknowledgeRawCapture: true and acknowledgeDangerousEval: true are required",
        "prefer a targeted inspection tool afterward and document why arbitrary evaluation was necessary",
        "arbitrary JavaScript can read or modify DOM, storage, page-visible credentials, and remote application state"
      ),
      inputSchema: browserEvalSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserEval(input)
    }),
    defineTool({
      name: "browser_get_cookies",
      title: "Read Browser Cookies",
      description: describeTool(
        "a full-profile authentication or cookie-specific diagnosis explicitly requires raw cookie values",
        "acknowledgeRawCapture: true and acknowledgeCredentialAccess: true are required on an authorized account",
        "inspect only the relevant cookie fields and avoid copying values into reports or code",
        "cookies are credentials and must be treated as secrets"
      ),
      inputSchema: browserGetCookiesSchema,
      annotations: ANNOTATIONS.browserRead,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserGetCookies(input)
    }),
    defineTool({
      name: "browser_set_cookies",
      title: "Set Browser Cookies",
      description: describeTool(
        "a full-profile authorized test explicitly requires establishing or changing cookie state",
        "acknowledgeRawCapture: true and acknowledgeCredentialAccess: true are required; use only intended test credentials",
        "verify the resulting flow without exposing cookie values and clear temporary state when appropriate",
        "this modifies credential state and raw cookie values are secrets"
      ),
      inputSchema: browserSetCookiesSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserSetCookies(input)
    }),
    defineTool({
      name: "browser_clear_cookies",
      title: "Clear Browser Cookies",
      description: describeTool(
        "a full-profile test needs a deliberate logged-out or clean-cookie state",
        "acknowledgeRawCapture: true and acknowledgeCredentialAccess: true are required; filters should be as narrow as possible",
        "reproduce the intended authentication or redirect behavior after clearing",
        "clearing cookies can sign out accounts and irreversibly remove session state from the active context"
      ),
      inputSchema: browserClearCookiesSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserClearCookies(input)
    }),
    defineTool({
      name: "browser_get_storage",
      title: "Read Web Storage",
      description: describeTool(
        "a full-profile authentication or application-state diagnosis explicitly requires localStorage or sessionStorage",
        "acknowledgeRawCapture: true and acknowledgeCredentialAccess: true are required for an authorized origin",
        "inspect only relevant keys and avoid returning raw secrets in summaries",
        "web storage frequently contains tokens, identifiers, preferences, and personal data"
      ),
      inputSchema: browserGetStorageSchema,
      annotations: ANNOTATIONS.browserRead,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserGetStorage(input)
    }),
    defineTool({
      name: "browser_set_storage",
      title: "Set Web Storage",
      description: describeTool(
        "a full-profile authorized test explicitly needs controlled localStorage or sessionStorage values",
        "acknowledgeRawCapture: true and acknowledgeCredentialAccess: true are required; target the intended origin and keys",
        "reload or navigate as needed to observe the application's reaction",
        "this changes potentially credential-bearing application state"
      ),
      inputSchema: browserSetStorageSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserSetStorage(input)
    }),
    defineTool({
      name: "browser_export_storage_state",
      title: "Export Storage State",
      description: describeTool(
        "a full-profile authorized workflow explicitly needs a Playwright storageState file for reproduction or transfer",
        "acknowledgeRawCapture: true and acknowledgeCredentialAccess: true are required and the output path must be protected",
        "use the file only for the intended test and remove it when no longer needed",
        "the exported file may contain reusable cookies, tokens, origins, and IndexedDB data"
      ),
      inputSchema: browserExportStorageStateSchema,
      annotations: ANNOTATIONS.browserWrite,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserExportStorageState(input)
    }),
    defineTool({
      name: "browser_import_storage_state",
      title: "Import Storage State",
      description: describeTool(
        "a full-profile authorized reproduction explicitly needs to replace active browser credential and origin state from a Playwright storageState file",
        "raw-capture and credential acknowledgements are required; CDP or userDataDir contexts also require acknowledgeStorageStateOverwrite: true",
        "navigate or reload to verify the intended authenticated state",
        "import clears and replaces cookies, localStorage, and IndexedDB and can overwrite a real logged-in profile"
      ),
      inputSchema: browserImportStorageStateSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserImportStorageState(input)
    }),
    defineTool({
      name: "monitor_start",
      title: "Start Raw Trace",
      description: describeTool(
        "a multi-step browser failure, transient DOM change, network race, WebSocket sequence, redirect, download, or authentication flow must be reproduced end to end",
        "an authorized browser must be active and acknowledgeRawCapture: true is required; normally set captureCookies: false and captureBodies: false unless directly relevant",
        "perform the complete reproduction with RawTrace browser actions, then call monitor_stop before reading monitor_get_summary",
        "trace streams can capture raw DOM, headers, values, frames, console data, cookies, bodies, and WebSocket messages depending on options"
      ),
      inputSchema: monitorStartSchema,
      annotations: ANNOTATIONS.browserWrite,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.monitorStart(input)
    }),
    defineTool({
      name: "monitor_stop",
      title: "Stop Raw Trace",
      description: describeTool(
        "the complete reproduction has finished and buffered trace events must be flushed before analysis",
        "a monitor should be active; avoid extra unrelated browser actions before stopping",
        "call monitor_get_summary first, then targeted search tools, and read a raw artifact only when necessary",
        "the resulting trace directory is sensitive and must not be committed or broadly shared"
      ),
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.localWrite,
      profiles: AGENT_PROFILES,
      handler: () => runtime.monitorStop()
    }),
    defineTool({
      name: "monitor_list_sessions",
      title: "List Trace Sessions",
      description: describeTool(
        "a full-profile workflow must enumerate trace sessions created by the current MCP process",
        "at least one trace session should exist",
        "select a session ID for manifest, summary, search, read, or export operations",
        "session paths and metadata may reveal local directories and sensitive investigation context"
      ),
      inputSchema: z.object({}),
      annotations: ANNOTATIONS.localRead,
      profiles: FULL_PROFILE,
      handler: () => runtime.monitorListSessions()
    }),
    defineTool({
      name: "monitor_get_manifest",
      title: "Get Trace Manifest",
      description: describeTool(
        "a full-profile workflow needs exact capture configuration, file inventory, schema, timing, or session metadata",
        "a completed or active trace session must exist",
        "prefer monitor_get_summary for diagnosis and use manifest paths only to target later reads",
        "the manifest can expose local paths, target URLs, capture options, and trace metadata"
      ),
      inputSchema: monitorGetManifestSchema,
      annotations: ANNOTATIONS.localRead,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.monitorGetManifest(input)
    }),
    defineTool({
      name: "monitor_get_summary",
      title: "Summarize Trace",
      description: describeTool(
        "a stopped multi-step trace needs the first compact AI-readable explanation of actions, DOM changes, requests, responses, WebSockets, console, and frames",
        "complete the reproduction and call monitor_stop first whenever possible",
        "use monitor_search_events or monitor_search_bodies only for questions the summary does not answer",
        "summaries minimize volume but may still include sensitive URLs, text, values, and event details"
      ),
      inputSchema: monitorSummarySchema,
      annotations: ANNOTATIONS.localRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.monitorGetSummary(input)
    }),
    defineTool({
      name: "monitor_read_events",
      title: "Read Raw Trace Events",
      description: describeTool(
        "a full-profile investigation needs paginated raw events after summary and search have identified the exact stream and range",
        "a trace session and explicit stream are required; keep offset and limit narrow",
        "correlate the returned sequence with a targeted artifact only if necessary",
        "raw events may contain DOM text, headers, form values, cookie metadata, console output, and WebSocket payloads"
      ),
      inputSchema: monitorReadEventsSchema,
      annotations: ANNOTATIONS.localRead,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.monitorReadEvents(input)
    }),
    defineTool({
      name: "monitor_search_events",
      title: "Search Trace Events",
      description: describeTool(
        "a trace summary leaves a targeted question about an endpoint, DOM text, event type, sequence boundary, redirect, or WebSocket message",
        "a trace session must exist; provide the narrowest useful stream and filters",
        "read only the matching artifact or small event range if more detail is needed",
        "matches may expose raw event fields, inline DOM content, URLs, headers, values, or payloads"
      ),
      inputSchema: monitorSearchEventsSchema,
      annotations: ANNOTATIONS.localRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.monitorSearchEvents(input)
    }),
    defineTool({
      name: "monitor_search_bodies",
      title: "Search Request and Response Bodies",
      description: describeTool(
        "authentication, API, GraphQL, request, or response content is directly relevant and body capture was enabled for the trace",
        "acknowledgeRawCapture: true and a precise text query are required on an authorized session",
        "use monitor_read_artifact only for the specific matching body reference that answers the question",
        "request and response bodies can contain credentials, personal data, application secrets, and large raw payloads"
      ),
      inputSchema: monitorSearchBodiesSchema,
      annotations: ANNOTATIONS.localRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.monitorSearchBodies(input)
    }),
    defineTool({
      name: "monitor_read_artifact",
      title: "Read Trace Artifact",
      description: describeTool(
        "summary and targeted search have identified one exact body, DOM, screenshot, eval, storage-state, or snapshot artifact needed to finish the diagnosis",
        "acknowledgeRawCapture: true and a trace-contained path or reference are required; keep maxBytes bounded",
        "extract only the necessary finding and do not dump the artifact into source control or broad logs",
        "artifacts are raw and can contain reusable credentials, personal data, secrets, screenshots, or full application content"
      ),
      inputSchema: monitorReadArtifactSchema,
      annotations: ANNOTATIONS.localRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.monitorReadArtifact(input)
    }),
    defineTool({
      name: "monitor_export",
      title: "Export Trace Bundle",
      description: describeTool(
        "an authorized handoff or offline analysis explicitly requires a portable ZIP of a completed trace",
        "a trace session must exist and the destination must be a protected local path",
        "share the bundle only through an approved sensitive-data channel and remove it when no longer needed",
        "the ZIP can contain every captured secret, body, cookie, DOM value, screenshot, and WebSocket frame"
      ),
      inputSchema: monitorExportSchema,
      annotations: ANNOTATIONS.localWrite,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.monitorExport(input)
    }),
    defineTool({
      name: "browser_click",
      title: "Click Element",
      description: describeTool(
        "a known element must be clicked during a traced multi-step reproduction and before/after aggregation is not needed",
        "an active page and a precise selector are required; prefer browser_observe_action_result when the outcome is uncertain",
        "continue the reproduction or inspect the resulting state and network events",
        "clicking can submit forms, mutate remote data, navigate, download files, or trigger other external effects"
      ),
      inputSchema: browserClickSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserClick(input)
    }),
    defineTool({
      name: "browser_type",
      title: "Type Into Element",
      description: describeTool(
        "text must be entered into a known input during a reproduction",
        "an active page and precise selector are required; use only data intended for the authorized target",
        "continue with the next action or observe the resulting request and DOM changes",
        "typed values may be captured in DOM, console, network, screenshots, or trace artifacts"
      ),
      inputSchema: browserTypeSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserType(input)
    }),
    defineTool({
      name: "browser_press",
      title: "Press Keyboard Key",
      description: describeTool(
        "a keyboard action such as Enter, Escape, Tab, or a shortcut is part of the browser reproduction",
        "an active page is required and the optional selector must identify the intended focus target",
        "continue the sequence or inspect any resulting navigation, dialog, DOM, or network activity",
        "key presses can submit data, trigger shortcuts, navigate, or mutate remote state"
      ),
      inputSchema: browserPressSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserPress(input)
    }),
    defineTool({
      name: "browser_hover",
      title: "Hover Element",
      description: describeTool(
        "hover-driven menus, tooltips, lazy content, or transient UI state must be reproduced",
        "an active page and precise selector are required",
        "inspect the transient DOM promptly or continue the monitored sequence",
        "hover handlers can trigger network requests, analytics, or application state changes"
      ),
      inputSchema: browserHoverSchema,
      annotations: ANNOTATIONS.browserWrite,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserHover(input)
    }),
    defineTool({
      name: "browser_scroll",
      title: "Scroll Page or Element",
      description: describeTool(
        "lazy loading, infinite scroll, sticky layout, viewport-dependent behavior, or an off-screen target must be reproduced",
        "an active page is required; provide a selector only when a specific scroll region matters",
        "wait for resulting activity or inspect DOM and network changes",
        "scroll listeners can trigger external requests, analytics, and dynamic content loading"
      ),
      inputSchema: browserScrollSchema,
      annotations: ANNOTATIONS.browserWrite,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserScroll(input)
    }),
    defineTool({
      name: "browser_select_option",
      title: "Select Option",
      description: describeTool(
        "one or more values must be selected in a native select control during a reproduction",
        "an active page, precise selector, and intended value, label, or index are required",
        "continue the flow or inspect dependent DOM and network activity",
        "selection can submit forms, alter application state, or expose chosen values in traces"
      ),
      inputSchema: browserSelectOptionSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserSelectOption(input)
    }),
    defineTool({
      name: "browser_check",
      title: "Check Form Control",
      description: describeTool(
        "a checkbox or radio control must be checked or unchecked during a reproduction",
        "an active page and precise selector are required",
        "continue the flow or inspect validation, DOM, and request changes",
        "changing a control can submit data, mutate remote state, or expose values in traces"
      ),
      inputSchema: browserCheckSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserCheck(input)
    }),
    defineTool({
      name: "browser_observe_action_result",
      title: "Observe Action Result",
      description: describeTool(
        "one click, type, press, check, select, hover, scroll, reload, navigate, or authorized eval has an unclear outcome and a compact before/after diff is needed",
        "an active page and acknowledgeRawCapture: true are required; eval actions also require acknowledgeDangerousEval: true",
        "use the returned DOM, state, network, and optional screenshot diff to decide whether a longer monitor_start reproduction is necessary",
        "before/after snapshots, values, screenshots, URLs, and network changes can contain sensitive raw page data"
      ),
      inputSchema: browserObserveActionResultSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserObserveActionResult(input)
    }),
    defineTool({
      name: "browser_wait_for_response",
      title: "Wait for Network Response",
      description: describeTool(
        "an action is expected to produce a response and timing or endpoint matching is the central question",
        "start this wait before triggering the relevant action and provide narrow URL, method, or status filters",
        "correlate the matched response with the action or use the body variant only when content matters",
        "response metadata can expose private URLs, headers, status details, and timing information"
      ),
      inputSchema: browserWaitForResponseSchema,
      annotations: ANNOTATIONS.browserRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserWaitForResponse(input)
    }),
    defineTool({
      name: "browser_wait_for_response_body",
      title: "Wait for Response Body",
      description: describeTool(
        "an action is expected to produce one response whose raw or parsed body is directly required for an API, authentication, redirect, or payload diagnosis",
        "start the wait before the action, use narrow filters, and pass acknowledgeRawCapture: true on an authorized system",
        "extract only the needed fields and prefer trace search for multi-request investigations",
        "response bodies may contain credentials, personal data, application secrets, or large binary content"
      ),
      inputSchema: browserWaitForResponseBodySchema,
      annotations: ANNOTATIONS.browserRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserWaitForResponseBody(input)
    }),
    defineTool({
      name: "browser_upload_file",
      title: "Upload Local File",
      description: describeTool(
        "a full-profile authorized test explicitly requires providing local files to a page file input",
        "acknowledgeFileAccess: true, an exact selector, and intended local paths are required",
        "continue the upload flow and verify the resulting request or UI state",
        "this sends local file contents to the target site and can expose private data"
      ),
      inputSchema: browserUploadFileSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserUploadFile(input)
    }),
    defineTool({
      name: "browser_wait_for_download",
      title: "Wait for Download",
      description: describeTool(
        "a browser action should create a download and the saved file, filename, or timing must be verified",
        "an active page is required; when triggerSelector is used it must identify the authorized download action, and raw capture requires acknowledgement",
        "inspect browser_get_downloads or the saved file through an appropriate local-file workflow",
        "downloaded files may contain sensitive application data and the optional trigger can cause external effects"
      ),
      inputSchema: browserWaitForDownloadSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserWaitForDownload(input)
    }),
    defineTool({
      name: "browser_get_downloads",
      title: "List Downloads",
      description: describeTool(
        "saved downloads from the current runtime must be located or verified after a download flow",
        "at least one download should have completed in this runtime",
        "use the relevant local file with an appropriate parser or test assertion",
        "download paths, filenames, URLs, and files can contain sensitive information"
      ),
      inputSchema: browserGetDownloadsSchema,
      annotations: ANNOTATIONS.localRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserGetDownloads(input)
    }),
    defineTool({
      name: "browser_set_viewport",
      title: "Set Browser Viewport",
      description: describeTool(
        "a full-profile reproduction explicitly depends on responsive breakpoints or viewport dimensions",
        "an active page and intended positive width and height are required",
        "reload or inspect the affected layout and events",
        "viewport changes can trigger application reflow, lazy loading, analytics, and network requests"
      ),
      inputSchema: browserSetViewportSchema,
      annotations: ANNOTATIONS.browserWrite,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserSetViewport(input)
    }),
    defineTool({
      name: "browser_grant_permissions",
      title: "Grant Browser Permissions",
      description: describeTool(
        "a full-profile authorized test explicitly requires browser permissions such as geolocation, notifications, camera, or microphone",
        "acknowledgePermissionChange: true and the minimal intended permission list are required",
        "run the permission-dependent flow and avoid granting unrelated capabilities",
        "permissions expose device-like capabilities and can change what the target page may access"
      ),
      inputSchema: browserGrantPermissionsSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserGrantPermissions(input)
    }),
    defineTool({
      name: "browser_set_geolocation",
      title: "Set Browser Geolocation",
      description: describeTool(
        "a full-profile authorized test explicitly depends on a controlled latitude, longitude, and accuracy",
        "acknowledgeLocationAccess: true is required and only intended coordinates may be supplied",
        "reload or exercise the location-dependent behavior",
        "the coordinates are exposed to authorized pages that have geolocation permission"
      ),
      inputSchema: browserSetGeolocationSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: FULL_PROFILE,
      handler: (input) => runtime.browserSetGeolocation(input)
    }),
    defineTool({
      name: "browser_get_forms",
      title: "Inspect Forms",
      description: describeTool(
        "form structure, labels, controls, values, validation state, or submit targets are needed before reproducing a form issue",
        "an active page and acknowledgeRawCapture: true are required; filter to the relevant form when possible",
        "use browser_fill_form for a multi-field reproduction or browser_observe_action_result for one uncertain control action",
        "form metadata can contain visible or hidden values, personal data, and credential fields"
      ),
      inputSchema: browserGetFormsSchema,
      annotations: ANNOTATIONS.browserRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserGetForms(input)
    }),
    defineTool({
      name: "browser_fill_form",
      title: "Fill Form",
      description: describeTool(
        "multiple form controls must be populated consistently and optionally submitted during a reproduction",
        "an active page and unambiguous field selectors, names, labels, or placeholders are required; provide only intended test data",
        "observe validation, submission requests, redirects, and final state",
        "filled values may be captured in the DOM, requests, screenshots, traces, or remote application state"
      ),
      inputSchema: browserFillFormSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserFillForm(input)
    }),
    defineTool({
      name: "browser_handle_dialog",
      title: "Handle JavaScript Dialog",
      description: describeTool(
        "an alert, confirm, prompt, or beforeunload dialog blocks or changes the browser reproduction",
        "configure the intended accept or dismiss behavior before the dialog appears",
        "trigger the dialog and inspect the resulting action, navigation, or state",
        "accepting prompts or confirmations can submit text, authorize actions, or mutate application state"
      ),
      inputSchema: browserHandleDialogSchema,
      annotations: ANNOTATIONS.browserAction,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserHandleDialog(input)
    }),
    defineTool({
      name: "browser_wait",
      title: "Wait for Browser Condition",
      description: describeTool(
        "the reproduction needs an explicit selector, URL, quiet-period, or bounded timeout wait instead of an arbitrary sleep",
        "an active page is required and mode-specific selector or pattern inputs should be narrow",
        "perform the next action immediately after the expected condition is reached",
        "waiting observes live page and network state but does not itself redact any subsequently captured data"
      ),
      inputSchema: browserWaitSchema,
      annotations: ANNOTATIONS.browserRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserWait(input)
    }),
    defineTool({
      name: "browser_poll_until",
      title: "Poll Until Page Conditions Match",
      description: describeTool(
        "asynchronous DOM, URL, element value, or authentication signals must be sampled until one or all conditions match",
        "an active page and acknowledgeRawCapture: true are required; use bounded timeout and interval values",
        "use the matched snapshot to continue the flow or explain the timing boundary",
        "poll snapshots can repeatedly capture raw text, values, URLs, authentication signals, and element metadata"
      ),
      inputSchema: browserPollUntilSchema,
      annotations: ANNOTATIONS.browserRead,
      profiles: AGENT_PROFILES,
      handler: (input) => runtime.browserPollUntil(input)
    })
  ];
}

function defineTool<T extends z.ZodType>(
  definition: Omit<ToolDefinition, "inputSchema" | "handler"> & {
    inputSchema: T;
    handler: (input: z.output<T>) => Promise<unknown>;
  }
): ToolDefinition {
  return {
    ...definition,
    handler: (input) => definition.handler(input as z.output<T>)
  };
}

function describeTool(useWhen: string, prerequisites: string, next: string, sensitivity: string): string {
  return `Use when ${useWhen}. Preconditions: ${prerequisites}. Next: ${next}. Sensitivity: ${sensitivity}.`;
}
