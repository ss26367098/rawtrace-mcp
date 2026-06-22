#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");
const cliPath = join(projectRoot, "dist", "cli.js");
const rawToken = "RAWTRACE_REAL_RUN_TOKEN_12345";
const rawCookieName = "rawtrace_real_cookie";
const rawCookieValue = "raw_cookie_value_12345";
const transientText = "rawtrace-transient-node-12345";
const wsPayload = "rawtrace-ws-payload-12345";
const consoleErrorText = "rawtrace-console-error-12345";
const typedText = "rawtrace typed text 12345";
const publicTools = [
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
];

async function main() {
  await assertDistExists();

  const runRoot = join(projectRoot, "rawtrace-traces", `real-run-${timestampForPath()}`);
  await mkdir(runRoot, { recursive: true });

  const report = {
    ok: false,
    runRoot,
    calledTools: [],
    transports: {},
    sessions: {},
    assertions: {}
  };

  let demo;
  try {
    demo = await startDemoApp();
    report.demoUrl = demo.url;

    await assertHttpSecurityFails(report);
    await runStdioSmoke(report, demo.url, runRoot);
    await runHttpAllTools(report, demo.url, runRoot);
    assertAllPublicToolsCalled(report);

    report.ok = true;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await demo?.close().catch(() => undefined);
  }
}

async function assertDistExists() {
  try {
    await stat(cliPath);
  } catch {
    throw new Error(`Missing ${cliPath}. Run "npm run build" before the real-run script.`);
  }
}

async function assertHttpSecurityFails(report) {
  const port = await getFreePort();
  const result = await runProcess(process.execPath, [
    cliPath,
    "--transport",
    "http",
    "--host",
    "0.0.0.0",
    "--port",
    String(port)
  ]);

  assert(result.code !== 0, "HTTP non-loopback without unsafe remote should fail", result);
  assert(
    /unsafe-remote|Non-loopback|HTTP transport/i.test(`${result.stdout}\n${result.stderr}`),
    "HTTP security failure should explain unsafe remote requirement",
    result
  );
  report.assertions.httpNonLoopbackWithoutTokenFails = true;
}

async function runStdioSmoke(report, demoUrl, runRoot) {
  const client = new Client({ name: "rawtrace-real-run-stdio", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath]
  });

  try {
    await client.connect(transport);
    report.transports.stdio = "connected";
    await callExpectError(report, client, "monitor_start", {}, "RAW_CAPTURE_ACK_REQUIRED");
    await callExpectError(report, client, "browser_get_state", {}, "RAW_CAPTURE_ACK_REQUIRED");

    await callOk(report, client, "browser_launch", { headless: true });
    await callOk(report, client, "browser_navigate", { url: demoUrl, waitUntil: "domcontentloaded" });
    const state = await callOk(report, client, "browser_get_state", { acknowledgeRawCapture: true });
    const dom = await callOk(report, client, "browser_get_dom", {
      acknowledgeRawCapture: true,
      selector: "#submit",
      mode: "text"
    });
    const elements = await callOk(report, client, "browser_get_elements", {
      acknowledgeRawCapture: true,
      textContains: "Submit",
      limit: 10
    });
    const snapshot = await callOk(report, client, "browser_snapshot", {
      acknowledgeRawCapture: true,
      elementsLimit: 10
    });
    const optimizedSelector = await callOk(report, client, "browser_optimize_selector", {
      acknowledgeRawCapture: true,
      selector: "#submit"
    });
    const screenshot = await callOk(report, client, "browser_screenshot", {
      acknowledgeRawCapture: true,
      outputPath: join(runRoot, "stdio-screenshot.png")
    });
    const annotatedScreenshot = await callOk(report, client, "browser_screenshot_annotated", {
      acknowledgeRawCapture: true,
      selector: "#submit",
      outputPath: join(runRoot, "stdio-screenshot-annotated.png")
    });

    const started = await callOk(report, client, "monitor_start", {
      acknowledgeRawCapture: true,
      outputDir: join(runRoot, "stdio-inspection")
    });
    await callOk(report, client, "browser_type", {
      selector: "#query",
      text: typedText,
      timeoutMs: 5000
    });
    await callOk(report, client, "browser_click", {
      selector: "#submit",
      timeoutMs: 5000
    });
    await callOk(report, client, "browser_wait", {
      mode: "quiet",
      quietMs: 300,
      timeoutMs: 5000
    });
    const bodySearch = await callOk(report, client, "monitor_search_bodies", {
      acknowledgeRawCapture: true,
      sessionId: started.sessionId,
      text: rawToken,
      urlContains: "/api/search",
      status: 200,
      limit: 10
    });
    await callOk(report, client, "monitor_stop", {});
    await callOk(report, client, "browser_close", {});

    assert(String(state.title).includes("RawTrace Real Run"), "stdio browser_get_state should return page title", state);
    assert(JSON.stringify(dom).includes("Submit"), "stdio browser_get_dom should return button text", dom);
    assert(JSON.stringify(elements).includes("#submit"), "stdio browser_get_elements should include button selector", elements);
    assert(JSON.stringify(elements).includes("recommendedSelector"), "stdio browser_get_elements should include selector metadata", elements);
    assert(JSON.stringify(snapshot).includes("RawTrace Real Run"), "stdio browser_snapshot should include page text", snapshot);
    assert(JSON.stringify(optimizedSelector).includes("#submit"), "stdio browser_optimize_selector should preserve stable selector", optimizedSelector);
    await stat(screenshot.outputPath);
    await stat(annotatedScreenshot.outputPath);
    assert(JSON.stringify(bodySearch).includes(rawToken), "stdio monitor_search_bodies should find raw request token", bodySearch);
    report.assertions.stdioInspectionTools = true;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runHttpAllTools(report, demoUrl, runRoot) {
  const http = await startHttpCliServer();
  const client = new Client({ name: "rawtrace-real-run-http", version: "0.0.0" });

  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
    report.transports.http = http.url;

    await runIsolatedBrowserScenario(report, client, demoUrl, runRoot);
    await runUserDataDirScenario(report, client, demoUrl, runRoot);
    await runCdpScenario(report, client, demoUrl, runRoot);
  } finally {
    await client.close().catch(() => undefined);
    await http.close().catch(() => undefined);
  }
}

async function runIsolatedBrowserScenario(report, client, demoUrl, runRoot) {
  const outputDir = join(runRoot, "http-isolated");
  const uploadPath = join(runRoot, "real-run-upload.txt");
  await writeFile(uploadPath, "rawtrace real-run upload payload", "utf8");

  await callOk(report, client, "browser_launch", { headless: true });
  await callOk(report, client, "browser_navigate", { url: demoUrl, waitUntil: "domcontentloaded" });
  await callExpectError(report, client, "monitor_start", {}, "RAW_CAPTURE_ACK_REQUIRED");
  const started = await callOk(report, client, "monitor_start", {
    acknowledgeRawCapture: true,
    outputDir
  });
  const sessionsRunning = await callOk(report, client, "monitor_list_sessions", {});
  const manifestRunning = await callOk(report, client, "monitor_get_manifest", {
    sessionId: started.sessionId
  });
  await callExpectError(report, client, "browser_get_dom", {}, "RAW_CAPTURE_ACK_REQUIRED");
  await callExpectError(report, client, "monitor_read_artifact", {
    acknowledgeRawCapture: true,
    sessionId: started.sessionId,
    path: "../outside.txt"
  }, "ARTIFACT_PATH_OUTSIDE_TRACE");

  const viewportResult = await callOk(report, client, "browser_set_viewport", {
    width: 777,
    height: 555
  });
  const state = await callOk(report, client, "browser_get_state", {
    acknowledgeRawCapture: true
  });
  const domInspection = await callOk(report, client, "browser_get_dom", {
    acknowledgeRawCapture: true,
    mode: "html",
    maxBytes: 10
  });
  const domArtifactRead = await callOk(report, client, "monitor_read_artifact", {
    acknowledgeRawCapture: true,
    sessionId: started.sessionId,
    ref: domInspection.html.ref,
    asText: true,
    maxBytes: 200000
  });
  const elementsInspection = await callOk(report, client, "browser_get_elements", {
    acknowledgeRawCapture: true,
    textContains: "Submit",
    limit: 10
  });
  const snapshotInspection = await callOk(report, client, "browser_snapshot", {
    acknowledgeRawCapture: true,
    elementsLimit: 20
  });
  const largeSnapshotInspection = await callOk(report, client, "browser_snapshot", {
    acknowledgeRawCapture: true,
    maxTextBytes: 10,
    elementsLimit: 5
  });
  const pollInitial = await callOk(report, client, "browser_poll_until", {
    acknowledgeRawCapture: true,
    timeoutMs: 2000,
    intervalMs: 100,
    conditions: [
      { type: "text", text: "RawTrace Real Run" },
      { type: "selector", selector: "#submit", state: "visible" }
    ],
    snapshot: {
      maxTextBytes: 2000,
      elementsLimit: 10
    }
  });
  const annotatedScreenshot = await callOk(report, client, "browser_screenshot_annotated", {
    acknowledgeRawCapture: true,
    selector: "#submit",
    outputPath: join(runRoot, "http-isolated-annotated.png")
  });
  const formsInspection = await callOk(report, client, "browser_get_forms", {
    acknowledgeRawCapture: true,
    textContains: "Profile",
    limit: 10
  });
  const formFill = await callOk(report, client, "browser_fill_form", {
    fields: [
      { name: "profileName", value: "Real Runner" },
      { label: "Profile Notes", value: "real-run form note" },
      { selector: "#profile-tier", value: "pro" },
      { selector: "#profile-enabled", checked: true }
    ],
    submitSelector: "#profile-submit",
    timeoutMs: 5000
  });
  const formStatus = await callOk(report, client, "browser_get_dom", {
    acknowledgeRawCapture: true,
    selector: "#status",
    mode: "text"
  });
  const uploadResult = await callOk(report, client, "browser_upload_file", {
    acknowledgeFileAccess: true,
    selector: "#upload-file",
    paths: [uploadPath],
    timeoutMs: 5000
  });
  const uploadedFormsInspection = await callOk(report, client, "browser_get_forms", {
    acknowledgeRawCapture: true,
    selector: "#upload-file",
    limit: 10
  });
  const optimizedDuplicateSelector = await callOk(report, client, "browser_optimize_selector", {
    acknowledgeRawCapture: true,
    selector: "#selector-lab > div:nth-of-type(2) > button",
    textContains: "Duplicate Action",
    includeRejected: true,
    candidateLimit: 20
  });
  const optimizedCheckinSelector = await callOk(report, client, "browser_optimize_selector", {
    acknowledgeRawCapture: true,
    selector: "#checkin-selector-lab button",
    textContains: "签到",
    includeRejected: true,
    candidateLimit: 20
  });
  const optimizedSpacePlaceholder = await callOk(report, client, "browser_optimize_selector", {
    acknowledgeRawCapture: true,
    selector: "#space-placeholder",
    includeRejected: true,
    candidateLimit: 20
  });
  const observedAction = await callOk(report, client, "browser_observe_action_result", {
    acknowledgeRawCapture: true,
    action: {
      type: "type",
      selector: "#space-placeholder",
      text: "observed real-run value",
      timeoutMs: 5000
    },
    beforeSnapshot: {
      elementsLimit: 10,
      maxTextBytes: 4000
    },
    afterSnapshot: {
      elementsLimit: 10,
      maxTextBytes: 4000
    },
    includeScreenshot: true,
    waitAfterMs: 100
  });
  await callOk(report, client, "browser_click", {
    selector: optimizedDuplicateSelector.recommended.selector,
    timeoutMs: 5000
  });
  const screenshot = await callOk(report, client, "browser_screenshot", {
    acknowledgeRawCapture: true,
    fullPage: true
  });
  const responseBodyPromise = callOk(report, client, "browser_wait_for_response_body", {
    acknowledgeRawCapture: true,
    urlContains: "/api/response-body",
    method: "GET",
    status: 200,
    parseJson: true,
    timeoutMs: 5000
  });
  await callOk(report, client, "browser_click", {
    selector: "#response-body-button",
    timeoutMs: 5000
  });
  const responseBody = await responseBodyPromise;
  const downloadResult = await callOk(report, client, "browser_wait_for_download", {
    acknowledgeRawCapture: true,
    triggerSelector: "#download-link",
    outputDir: join(runRoot, "downloads"),
    timeoutMs: 5000
  });
  const downloadsInspection = await callOk(report, client, "browser_get_downloads", {
    limit: 10
  });
  await callOk(report, client, "browser_grant_permissions", {
    acknowledgePermissionChange: true,
    permissions: ["geolocation"],
    origin: demoUrl
  });
  await callOk(report, client, "browser_set_geolocation", {
    acknowledgeLocationAccess: true,
    latitude: 22.3193,
    longitude: 114.1694,
    accuracy: 10
  });
  await callOk(report, client, "browser_click", {
    selector: "#geolocation-button",
    timeoutMs: 5000
  });
  await callOk(report, client, "browser_wait", {
    mode: "quiet",
    quietMs: 100,
    timeoutMs: 3000
  });
  const geolocationStatus = await callOk(report, client, "browser_get_dom", {
    acknowledgeRawCapture: true,
    selector: "#status",
    mode: "text"
  });
  const tabsBefore = await callOk(report, client, "browser_list_tabs", {});
  const initialPageId = tabsBefore.pages[0].pageId;

  await callExpectError(report, client, "browser_eval", {
    acknowledgeRawCapture: true,
    expression: "1 + 1"
  }, "DANGEROUS_EVAL_ACK_REQUIRED");
  await callExpectError(report, client, "browser_get_cookies", {
    acknowledgeRawCapture: true
  }, "CREDENTIAL_ACCESS_ACK_REQUIRED");

  await callOk(report, client, "browser_handle_dialog", {
    action: "accept"
  });
  await callOk(report, client, "browser_click", {
    selector: "#dialog-button",
    timeoutMs: 5000
  });
  await callOk(report, client, "browser_hover", {
    selector: "#hover-target",
    timeoutMs: 5000
  });
  await callOk(report, client, "browser_select_option", {
    selector: "#choice",
    values: "beta",
    timeoutMs: 5000
  });
  await callOk(report, client, "browser_check", {
    selector: "#agree",
    checked: true,
    timeoutMs: 5000
  });

  await callOk(report, client, "browser_type", {
    selector: "#query",
    text: typedText,
    delayMs: 0,
    timeoutMs: 5000
  });
  await callOk(report, client, "browser_press", {
    selector: "#query",
    key: "Enter",
    timeoutMs: 5000
  });
  const delayedResponsePromise = callOk(report, client, "browser_wait_for_response", {
    urlContains: "/api/delayed",
    method: "GET",
    status: 200,
    timeoutMs: 5000
  });
  await callOk(report, client, "browser_click", {
    selector: "#delayed-button",
    timeoutMs: 5000
  });
  const delayedResponse = await delayedResponsePromise;
  await callOk(report, client, "browser_scroll", {
    selector: "#bottom-button",
    deltaY: 800,
    timeoutMs: 5000
  });
  const accessibilityInspection = await callOk(report, client, "browser_get_accessibility", {
    acknowledgeRawCapture: true,
    textContains: "RawTrace Real Run",
    limit: 20
  });
  const evalInspection = await callOk(report, client, "browser_eval", {
    acknowledgeRawCapture: true,
    acknowledgeDangerousEval: true,
    expression: "({ status: document.querySelector('#status')?.textContent, title: document.title })"
  });
  const largeEvalInspection = await callOk(report, client, "browser_eval", {
    acknowledgeRawCapture: true,
    acknowledgeDangerousEval: true,
    expression: "'x'.repeat(70000)",
    maxBytes: 10
  });
  await callOk(report, client, "browser_set_storage", {
    acknowledgeRawCapture: true,
    acknowledgeCredentialAccess: true,
    localStorage: {
      "rawtrace-real-storage": "storage-value-12345"
    },
    sessionStorage: {
      "rawtrace-real-session": "session-value-12345"
    }
  });
  const storageInspection = await callOk(report, client, "browser_get_storage", {
    acknowledgeRawCapture: true,
    acknowledgeCredentialAccess: true
  });
  const storageStatePath = join(runRoot, "http-storage-state.json");
  const exportedStorageState = await callOk(report, client, "browser_export_storage_state", {
    acknowledgeRawCapture: true,
    acknowledgeCredentialAccess: true,
    outputPath: storageStatePath
  });
  await callOk(report, client, "browser_set_cookies", {
    acknowledgeRawCapture: true,
    acknowledgeCredentialAccess: true,
    cookies: [
      {
        name: "rawtrace_real_manual_cookie",
        value: "manual-cookie-value-12345",
        url: demoUrl
      }
    ]
  });
  const cookiesInspection = await callOk(report, client, "browser_get_cookies", {
    acknowledgeRawCapture: true,
    acknowledgeCredentialAccess: true,
    urls: [demoUrl]
  });
  await callOk(report, client, "browser_clear_cookies", {
    acknowledgeRawCapture: true,
    acknowledgeCredentialAccess: true,
    name: "rawtrace_real_manual_cookie"
  });
  await callOk(report, client, "browser_import_storage_state", {
    acknowledgeRawCapture: true,
    acknowledgeCredentialAccess: true,
    path: storageStatePath
  });
  await callOk(report, client, "browser_click", {
    selector: "#submit",
    timeoutMs: 5000
  });
  await callOk(report, client, "browser_wait", {
    mode: "selector",
    selector: "#results .row",
    timeoutMs: 5000
  });
  await callOk(report, client, "browser_wait", {
    mode: "url",
    pattern: "127.0.0.1",
    timeoutMs: 5000
  });
  await callOk(report, client, "browser_wait", {
    mode: "timeout",
    delayMs: 20,
    timeoutMs: 1000
  });
  await callOk(report, client, "browser_wait", {
    mode: "quiet",
    quietMs: 300,
    timeoutMs: 5000
  });

  await callExpectError(report, client, "browser_wait", {
    mode: "selector",
    timeoutMs: 100
  }, "WAIT_SELECTOR_REQUIRED");
  await callExpectError(report, client, "browser_click", {
    selector: "#does-not-exist",
    timeoutMs: 100
  });

  const summary = await callOk(report, client, "monitor_get_summary", { sessionId: started.sessionId });
  const domSearch = await callOk(report, client, "monitor_search_events", {
    sessionId: started.sessionId,
    stream: "dom",
    text: transientText,
    limit: 10
  });
  const networkSearch = await callOk(report, client, "monitor_search_events", {
    sessionId: started.sessionId,
    stream: "network",
    urlContains: "/api/search",
    limit: 10
  });
  const bodySearch = await callOk(report, client, "monitor_search_bodies", {
    acknowledgeRawCapture: true,
    sessionId: started.sessionId,
    text: rawToken,
    urlContains: "/api/search",
    status: 200,
    limit: 10
  });
  const bodyArtifactRead = await callOk(report, client, "monitor_read_artifact", {
    acknowledgeRawCapture: true,
    sessionId: started.sessionId,
    ref: bodySearch.matches[0].bodyRef,
    asText: true,
    maxBytes: 200000
  });
  const networkInspection = await callOk(report, client, "browser_get_network", {
    sessionId: started.sessionId,
    urlContains: "/api/delayed",
    status: 200,
    limit: 10
  });
  await callExpectError(report, client, "monitor_read_events", {
    sessionId: started.sessionId,
    stream: "dom",
    limit: 1001
  }, "LIMIT_TOO_LARGE");
  await callOk(report, client, "browser_navigate", {
    url: `${demoUrl}/second`,
    waitUntil: "domcontentloaded"
  });
  const backNavigation = await callOk(report, client, "browser_go_back", {
    waitUntil: "domcontentloaded",
    timeoutMs: 5000
  });
  const forwardNavigation = await callOk(report, client, "browser_go_forward", {
    waitUntil: "domcontentloaded",
    timeoutMs: 5000
  });
  const reloadNavigation = await callOk(report, client, "browser_reload", {
    waitUntil: "domcontentloaded",
    timeoutMs: 5000
  });
  const newTab = await callOk(report, client, "browser_new_tab", {
    url: `${demoUrl}/second`,
    waitUntil: "domcontentloaded"
  });
  const tabsAfterNew = await callOk(report, client, "browser_list_tabs", {});
  await callOk(report, client, "browser_switch_tab", {
    pageId: initialPageId
  });
  await callOk(report, client, "browser_close_tab", {
    pageId: newTab.pageId
  });
  const tabsAfterClose = await callOk(report, client, "browser_list_tabs", {});
  const streamsBeforeStop = await readAllStreams(report, client, started.sessionId, 0, 200);
  const stopped = await callOk(report, client, "monitor_stop", {});
  const sessionsStopped = await callOk(report, client, "monitor_list_sessions", {});
  const exported = await callOk(report, client, "monitor_export", {
    sessionId: started.sessionId,
    format: "zip"
  });
  await callOk(report, client, "browser_close", {});
  const streams = await readAllStreams(report, client, started.sessionId, 0, 1000);
  const secondDomChunk = await callOk(report, client, "monitor_read_events", {
    sessionId: started.sessionId,
    stream: "dom",
    offset: 1,
    limit: 1
  });

  await assertTraceArtifacts({
    report,
    started,
    stopped,
    exported,
    sessionsRunning,
    sessionsStopped,
    manifestRunning,
    summary,
    domSearch,
    networkSearch,
    bodySearch,
    bodyArtifactRead,
    networkInspection,
    state,
    viewportResult,
    domInspection,
    domArtifactRead,
    elementsInspection,
    snapshotInspection,
    largeSnapshotInspection,
    pollInitial,
    observedAction,
    annotatedScreenshot,
    formsInspection,
    formFill,
    formStatus,
    uploadResult,
    uploadedFormsInspection,
    optimizedDuplicateSelector,
    optimizedCheckinSelector,
    optimizedSpacePlaceholder,
    screenshot,
    responseBody,
    downloadResult,
    downloadsInspection,
    geolocationStatus,
    delayedResponse,
    accessibilityInspection,
    evalInspection,
    largeEvalInspection,
    storageInspection,
    exportedStorageState,
    cookiesInspection,
    backNavigation,
    forwardNavigation,
    reloadNavigation,
    tabsBefore,
    tabsAfterNew,
    tabsAfterClose,
    streams,
    streamsBeforeStop,
    secondDomChunk
  });
}

async function runUserDataDirScenario(report, client, demoUrl, runRoot) {
  const userDataDir = join(runRoot, "explicit-user-data-dir");
  const storageStatePath = join(runRoot, "launch-storage-state.json");
  await mkdir(userDataDir, { recursive: true });
  await writeFile(
    storageStatePath,
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: demoUrl,
          localStorage: [{ name: "launch-storage-key", value: "launch-storage-value" }]
        }
      ]
    }),
    "utf8"
  );

  const launched = await callOk(report, client, "browser_launch", {
    headless: true,
    userDataDir,
    storageStatePath,
    acknowledgeRawCapture: true,
    acknowledgeCredentialAccess: true,
    acknowledgeStorageStateOverwrite: true
  });
  await callOk(report, client, "browser_navigate", {
    url: demoUrl,
    waitUntil: "domcontentloaded"
  });
  const storage = await callOk(report, client, "browser_get_storage", {
    acknowledgeRawCapture: true,
    acknowledgeCredentialAccess: true
  });
  await callOk(report, client, "browser_close", {});

  await stat(userDataDir);
  report.assertions.browserLaunchUserDataDir = launched.mode === "isolated" && launched.detail === userDataDir;
  assert(report.assertions.browserLaunchUserDataDir, "browser_launch should report explicit userDataDir mode", launched);
  report.assertions.browserLaunchStorageStatePath = JSON.stringify(storage).includes("launch-storage-value");
  assert(report.assertions.browserLaunchStorageStatePath, "browser_launch should import storageStatePath", storage);
}

async function runCdpScenario(report, client, demoUrl, runRoot) {
  const remote = await startRemoteDebuggingChromium(runRoot);
  try {
    const attached = await callOk(report, client, "browser_attach_cdp", {
      cdpUrl: remote.cdpUrl,
      targetIndex: 0
    });
    await callOk(report, client, "browser_navigate", {
      url: `${demoUrl}/second`,
      waitUntil: "domcontentloaded"
    });
    const attachedTabs = await callOk(report, client, "browser_list_tabs", {});
    await callOk(report, client, "browser_close", {});

    const launched = await callOk(report, client, "browser_launch", {
      cdpUrl: remote.cdpUrl
    });
    await callOk(report, client, "browser_navigate", {
      url: demoUrl,
      waitUntil: "domcontentloaded"
    });
    await callOk(report, client, "browser_close", {});

    report.assertions.browserLaunchCdp = launched.mode === "cdp";
    assert(report.assertions.browserLaunchCdp, "browser_launch should report cdp mode", launched);
    report.assertions.browserAttachCdp = attached.mode === "cdp" && attachedTabs.pages.length >= 1;
    assert(report.assertions.browserAttachCdp, "browser_attach_cdp should attach to remote Chromium and list tabs", {
      attached,
      attachedTabs
    });
  } finally {
    await remote.close().catch(() => undefined);
  }
}

async function assertTraceArtifacts({
  report,
  started,
  stopped,
  exported,
  sessionsRunning,
  sessionsStopped,
  manifestRunning,
  summary,
  domSearch,
  networkSearch,
  bodySearch,
  bodyArtifactRead,
  networkInspection,
  state,
  viewportResult,
  domInspection,
  domArtifactRead,
  elementsInspection,
  snapshotInspection,
  largeSnapshotInspection,
  pollInitial,
  observedAction,
  annotatedScreenshot,
  formsInspection,
  formFill,
  formStatus,
  uploadResult,
  uploadedFormsInspection,
  optimizedDuplicateSelector,
  optimizedCheckinSelector,
  optimizedSpacePlaceholder,
  screenshot,
  responseBody,
  downloadResult,
  downloadsInspection,
  geolocationStatus,
  delayedResponse,
  accessibilityInspection,
  evalInspection,
  largeEvalInspection,
  storageInspection,
  exportedStorageState,
  cookiesInspection,
  backNavigation,
  forwardNavigation,
  reloadNavigation,
  tabsBefore,
  tabsAfterNew,
  tabsAfterClose,
  streams,
  streamsBeforeStop,
  secondDomChunk
}) {
  const manifestPath = join(started.outputDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const zipBytes = await readFile(exported.outputPath);
  const zipText = zipBytes.toString("latin1");
  const networkText = JSON.stringify(streams.network.events);
  const domText = JSON.stringify(streams.dom.events);
  const cookieText = JSON.stringify(streams.cookies.events);
  const websocketText = JSON.stringify(streams.websocket.events);
  const consoleText = JSON.stringify(streams.console.events);
  const frameText = JSON.stringify(streams.frames.events);
  const actionsText = JSON.stringify(streams.actions.events);
  const summaryText = JSON.stringify(summary);

  for (const stream of ["actions", "dom", "network", "cookies", "websocket", "console", "frames"]) {
    assert(streams[stream].total > 0, `${stream} stream should have events`, streams[stream]);
  }
  assert(streams.all.total >= Object.values(streams).filter((value) => typeof value.total === "number").length, "all stream should be readable");
  assert(secondDomChunk.events.length === 1, "monitor_read_events offset/limit should return one DOM event", secondDomChunk);

  assert(domText.includes(transientText), "DOM stream should include transient text");
  assert(domText.includes(typedText), "DOM stream should include typed input value");
  assert(networkText.includes("/api/search"), "Network stream should include API call");
  assert(networkText.includes(rawToken), "Network stream should include raw request token");
  assert(cookieText.includes(rawCookieName), "Cookie stream should include raw cookie name");
  assert(cookieText.includes(rawCookieValue), "Cookie stream should include raw cookie value");
  assert(websocketText.includes(wsPayload), "WebSocket stream should include sent payload");
  assert(consoleText.includes(consoleErrorText), "Console stream should include console error");
  assert(frameText.includes("/frame"), "Frame stream should include iframe navigation");
  assert(actionsText.includes("click.error"), "Action stream should include failed click error");
  assert(actionsText.includes("wait.error"), "Action stream should include failed wait error");
  assert(actionsText.includes("eval.end"), "Action stream should include eval events");
  assert(actionsText.includes("handle_dialog.end"), "Action stream should include dialog handler registration");
  assert(actionsText.includes("wait_for_response.end"), "Action stream should include response wait events");
  assert(actionsText.includes("inspect.snapshot.end"), "Action stream should include snapshot inspection events");
  assert(actionsText.includes("poll_until.end"), "Action stream should include poll events");
  assert(actionsText.includes("observe_action_result.end"), "Action stream should include observed action events");
  assert(actionsText.includes("inspect.screenshot_annotated.end"), "Action stream should include annotated screenshot events");

  const responseBodyRefs = streams.network.events
    .map((event) => event.bodyRef)
    .filter((bodyRef) => bodyRef && typeof bodyRef.path === "string");
  assert(responseBodyRefs.length > 0, "Network stream should include response body references", streams.network.events);
  assert(JSON.stringify(bodyArtifactRead).includes(rawToken), "monitor_read_artifact should read bodyRef content through MCP", bodyArtifactRead);

  assert(JSON.stringify(sessionsRunning).includes(started.sessionId), "monitor_list_sessions should include running session", sessionsRunning);
  assert(JSON.stringify(sessionsStopped).includes('"status":"stopped"'), "monitor_list_sessions should include stopped session", sessionsStopped);
  assert(manifestRunning.sessionId === started.sessionId && manifestRunning.status === "running", "monitor_get_manifest should return running manifest", manifestRunning);
  assert(summaryText.includes("/api/search"), "Summary should include request information", summary);
  assert(summaryText.includes("DOM events clustered"), "Summary should include DOM cluster information", summary);
  assert(summaryText.includes(consoleErrorText), "Summary should include console error information", summary);
  assert(JSON.stringify(domSearch).includes(transientText), "monitor_search_events should find transient DOM text", domSearch);
  assert(JSON.stringify(networkSearch).includes("/api/search"), "monitor_search_events should find API requests", networkSearch);
  assert(JSON.stringify(networkInspection).includes("/api/delayed"), "browser_get_network should find delayed API", networkInspection);
  assert(String(state.title).includes("RawTrace Real Run"), "browser_get_state should return current page title", state);
  assert(viewportResult.viewport?.width === 777 && viewportResult.viewport?.height === 555, "browser_set_viewport should set active page size", viewportResult);
  assert(state.viewport?.width === 777 && state.viewport?.height === 555, "browser_get_state should reflect viewport changes", state);
  assert(JSON.stringify(domInspection).includes("body") || JSON.stringify(domInspection).includes("dom_html"), "browser_get_dom should return or reference HTML", domInspection);
  assert(JSON.stringify(domArtifactRead).includes("RawTrace Real Run"), "monitor_read_artifact should read DOM artifact text", domArtifactRead);
  assert(JSON.stringify(elementsInspection).includes("#submit"), "browser_get_elements should include interactive button", elementsInspection);
  assert(JSON.stringify(elementsInspection).includes("recommendedSelector"), "browser_get_elements should include selector recommendation metadata", elementsInspection);
  assert(JSON.stringify(elementsInspection).includes("clickable"), "browser_get_elements should include clickability metadata", elementsInspection);
  assert(JSON.stringify(snapshotInspection).includes("RawTrace Real Run"), "browser_snapshot should include visible page text", snapshotInspection);
  assert(JSON.stringify(snapshotInspection).includes("formsSummary"), "browser_snapshot should include form summary", snapshotInspection);
  assert(largeSnapshotInspection.text?.ref || largeSnapshotInspection.text?.outputPath, "browser_snapshot should externalize large text", largeSnapshotInspection);
  assert(pollInitial.matched === true && pollInitial.sampleCount >= 1, "browser_poll_until should match page signals", pollInitial);
  assert(JSON.stringify(observedAction.diff).includes("observed real-run value"), "browser_observe_action_result should report input value changes", observedAction);
  assert(observedAction.screenshots?.before?.outputPath && observedAction.screenshots?.after?.outputPath, "browser_observe_action_result should capture before/after screenshots", observedAction);
  await stat(observedAction.screenshots.before.outputPath);
  await stat(observedAction.screenshots.after.outputPath);
  await stat(annotatedScreenshot.outputPath);
  assert(annotatedScreenshot.annotations?.length > 0, "browser_screenshot_annotated should return annotation metadata", annotatedScreenshot);
  assert(JSON.stringify(formsInspection).includes("profileName"), "browser_get_forms should include profile form controls", formsInspection);
  assert(formFill.filledCount === 4 && formFill.submitted === true, "browser_fill_form should fill and submit form", formFill);
  assert(JSON.stringify(formStatus).includes("profile:Real Runner:pro:true"), "browser_fill_form should update form status", formStatus);
  assert(uploadResult.uploaded === true && uploadResult.fileCount === 1, "browser_upload_file should upload local file", uploadResult);
  assert(JSON.stringify(uploadedFormsInspection).includes("real-run-upload.txt"), "browser_get_forms should show uploaded filename", uploadedFormsInspection);
  assert(JSON.stringify(optimizedDuplicateSelector).includes("Selector Target"), "browser_optimize_selector should use semantic anchor for duplicate text", optimizedDuplicateSelector);
  assert(JSON.stringify(optimizedDuplicateSelector).includes("not_unique"), "browser_optimize_selector should report rejected broad selectors", optimizedDuplicateSelector);
  assert(!String(optimizedDuplicateSelector.recommended?.selector).includes("base-ui-_r_dynamic"), "browser_optimize_selector should not recommend dynamic ids", optimizedDuplicateSelector);
  assert(String(optimizedCheckinSelector.recommended?.selector).includes("立即签到"), "browser_optimize_selector should prefer actual target text over a broad hint", optimizedCheckinSelector);
  assert(String(optimizedCheckinSelector.recommended?.selector) !== 'button:has-text("签到")', "browser_optimize_selector should not recommend only the broad hint when actual text is available", optimizedCheckinSelector);
  assert(
    optimizedSpacePlaceholder.candidates.some((candidate) => candidate.selector === 'input[placeholder="First  name"]'),
    "browser_optimize_selector should preserve meaningful whitespace inside attribute selectors",
    optimizedSpacePlaceholder
  );
  assert(
    !optimizedSpacePlaceholder.candidates.some((candidate) => candidate.selector === 'input[placeholder="First name"]'),
    "browser_optimize_selector should not collapse whitespace inside attribute selectors",
    optimizedSpacePlaceholder
  );
  assert(JSON.stringify(bodySearch).includes(rawToken), "monitor_search_bodies should find raw request body token", bodySearch);
  assert(JSON.stringify(responseBody).includes("RAW_REAL_RESPONSE_BODY_TOKEN"), "browser_wait_for_response_body should return parsed body", responseBody);
  await stat(downloadResult.outputPath);
  assert(JSON.stringify(downloadsInspection).includes(downloadResult.downloadId), "browser_get_downloads should include saved download", downloadsInspection);
  assert(JSON.stringify(geolocationStatus).includes("geo:22.319,114.169"), "browser_set_geolocation and browser_grant_permissions should allow geolocation reads", geolocationStatus);
  assert(delayedResponse.status === 200, "browser_wait_for_response should return delayed response", delayedResponse);
  assert(JSON.stringify(accessibilityInspection).includes("heading"), "browser_get_accessibility should include heading role", accessibilityInspection);
  assert(JSON.stringify(evalInspection).includes("real-run-delayed-response"), "browser_eval should return page state", evalInspection);
  assert(largeEvalInspection.result?.ref || largeEvalInspection.result?.outputPath, "browser_eval should externalize large results", largeEvalInspection);
  assert(JSON.stringify(storageInspection).includes("storage-value-12345"), "browser_get_storage should return raw storage values", storageInspection);
  assert(exportedStorageState.state?.outputPath, "browser_export_storage_state should write a storageState file", exportedStorageState);
  await stat(exportedStorageState.state.outputPath);
  assert(JSON.stringify(cookiesInspection).includes("rawtrace_real_manual_cookie"), "browser_get_cookies should return manual cookie", cookiesInspection);
  assert(String(backNavigation.url).endsWith("/"), "browser_go_back should navigate to root", backNavigation);
  assert(String(forwardNavigation.url).endsWith("/second"), "browser_go_forward should navigate to second page", forwardNavigation);
  assert(String(reloadNavigation.url).endsWith("/second"), "browser_reload should keep second page", reloadNavigation);
  assert(tabsBefore.pages.length >= 1, "browser_list_tabs should return initial tab", tabsBefore);
  assert(tabsAfterNew.pages.length >= 2, "browser_new_tab should add a tab", tabsAfterNew);
  assert(tabsAfterClose.pages.length === 1, "browser_close_tab should close the extra tab", tabsAfterClose);
  await stat(screenshot.outputPath);
  assert(manifest.status === "stopped", "Manifest should be stopped", manifest);
  assert(manifest.traceSchemaVersion === "1.0.0", "Manifest should use trace schema v1", manifest);
  for (const flag of ["captureDom", "captureNetwork", "captureCookies", "captureBodies", "captureWebSockets", "captureConsole", "captureFrames"]) {
    assert(manifest.captureOptions[flag] === true, `Manifest ${flag} should default true`, manifest.captureOptions);
  }
  await stat(join(started.outputDir, "snapshots", "initial-dom.html"));
  await stat(join(started.outputDir, "snapshots", "final-dom.html"));
  assert(zipBytes.byteLength > 0, "monitor_export zip should not be empty", exported);
  for (const zipName of ["manifest.json", "actions.ndjson", "dom.ndjson", "network.ndjson", "cookies.ndjson", "websocket.ndjson", "console.ndjson", "frames.ndjson", "bodies/", "snapshots/"]) {
    assert(zipText.includes(zipName), `Export zip should contain ${zipName}`);
  }

  report.sessions.isolated = {
    sessionId: started.sessionId,
    outputDir: started.outputDir,
    exportPath: exported.outputPath,
    exportBytes: zipBytes.byteLength,
    eventCounts: stopped.eventCounts,
    streamTotals: Object.fromEntries(Object.entries(streams).map(([stream, value]) => [stream, value.total])),
    streamTotalsBeforeStop: Object.fromEntries(Object.entries(streamsBeforeStop).map(([stream, value]) => [stream, value.total])),
    summaryHighlights: summary.highlights,
    searchMatches: {
      dom: domSearch.matches.length,
      network: networkSearch.matches.length,
      bodies: bodySearch.matches.length
    },
    inspections: {
      stateTitle: state.title,
      domExternalized: Boolean(domInspection.html?.ref),
      elements: elementsInspection.elements?.length,
      snapshotElements: snapshotInspection.elements?.length,
      pollSamples: pollInitial.sampleCount,
      observedAction: observedAction.diff,
      forms: formsInspection.forms?.length,
      downloadedPath: downloadResult.outputPath,
      responseBodyStatus: responseBody.status,
      optimizedSelector: optimizedDuplicateSelector.recommended?.selector,
      screenshotPath: screenshot.outputPath,
      annotatedScreenshotPath: annotatedScreenshot.outputPath,
      accessibilityElements: accessibilityInspection.elements?.length,
      networkInspectionEvents: networkInspection.events?.length,
      storageStatePath: exportedStorageState.state?.outputPath
    }
  };
  report.assertions.rawCaptureSignals = {
    domTransient: true,
    typedInput: true,
    requestBodyToken: true,
    responseBodyFileReadable: true,
    cookieNameAndValue: true,
    websocketPayload: true,
    consoleError: true,
    iframeFrameEvent: true,
    actionErrors: true,
    zipLayout: true,
    chunkedRead: true,
    eventSearch: true,
    bodySearch: true,
    inspectionTools: true,
    selectorOptimization: true,
    observationAggregation: true,
    expandedBrowserTools: true,
    evalTool: true,
    credentialStateTools: true,
    tabTools: true,
    networkInspection: true,
    artifactRead: true,
    responseBodyRead: true,
    fileUpload: true,
    downloads: true,
    viewport: true,
    permissionsAndGeolocation: true,
    forms: true,
    readLimitError: true
  };
}

async function readAllStreams(report, client, sessionId, offset, limit) {
  const result = {};
  for (const stream of ["actions", "dom", "network", "cookies", "websocket", "console", "frames", "all"]) {
    result[stream] = await callOk(report, client, "monitor_read_events", {
      sessionId,
      stream,
      offset,
      limit
    });
  }
  return result;
}

async function callOk(report, client, name, args = {}) {
  report.calledTools.push(name);
  const parsed = parseToolResponse(name, await client.callTool({ name, arguments: args }));
  if (!parsed.ok) {
    throw new Error(`${name} failed unexpectedly: ${JSON.stringify(parsed.error, null, 2)}`);
  }
  return parsed.result;
}

async function callExpectError(report, client, name, args = {}, expectedCode) {
  report.calledTools.push(`${name}(expected-error)`);
  const parsed = parseToolResponse(name, await client.callTool({ name, arguments: args }));
  if (parsed.ok) {
    throw new Error(`${name} unexpectedly succeeded`);
  }
  if (expectedCode && parsed.error?.code !== expectedCode) {
    throw new Error(`${name} expected ${expectedCode}, got ${JSON.stringify(parsed.error, null, 2)}`);
  }
  return parsed.error;
}

function parseToolResponse(name, result) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) {
    throw new Error(`${name} did not return text content: ${JSON.stringify(result)}`);
  }
  return JSON.parse(text);
}

function assertAllPublicToolsCalled(report) {
  const called = new Set(report.calledTools.map((name) => String(name).replace(/\(expected-error\)$/, "")));
  const missing = publicTools.filter((name) => !called.has(name));
  assert(missing.length === 0, `All public MCP tools should be called at least once. Missing: ${missing.join(", ")}`, {
    missing,
    called: [...called].sort()
  });
  report.assertions.allPublicToolsCalled = {
    count: publicTools.length,
    tools: publicTools
  };
}

async function startHttpCliServer() {
  const port = await getFreePort();
  const child = spawn(process.execPath, [
    cliPath,
    "--transport",
    "http",
    "--host",
    "127.0.0.1",
    "--port",
    String(port)
  ], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const url = `http://127.0.0.1:${port}/mcp`;
  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`HTTP MCP server exited early with code ${child.exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    }
    return stderr.includes("RawTrace MCP listening") || (await canConnectHttp(port));
  }, 10_000, "HTTP MCP server to start");

  return {
    url,
    close: async () => {
      if (child.exitCode === null) {
        child.kill();
        await waitForProcessExit(child, 5_000);
      }
    }
  };
}

async function startRemoteDebuggingChromium(runRoot) {
  const port = await getFreePort();
  const userDataDir = join(runRoot, "cdp-remote-profile");
  await mkdir(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: [
      `--remote-debugging-port=${port}`
    ]
  });
  const cdpUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    const response = await fetch(`${cdpUrl}/json/version`).catch(() => undefined);
    return response?.ok === true;
  }, 10_000, "remote debugging Chromium to expose CDP");
  return {
    cdpUrl,
    close: async () => {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

async function startDemoApp() {
  const server = createHttpServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(indexHtml());
      return;
    }
    if (req.url?.startsWith("/frame")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(frameHtml());
      return;
    }
    if (req.url === "/second") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(secondHtml());
      return;
    }
    if (req.url === "/api/delayed") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, marker: "real-run-delayed-response" }));
      }, 40);
      return;
    }
    if (req.url === "/api/response-body") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, marker: "real-run-response-body", token: "RAW_REAL_RESPONSE_BODY_TOKEN" }));
      return;
    }
    if (req.url === "/download/report.txt") {
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": "attachment; filename=\"rawtrace-real-report.txt\""
      });
      res.end("rawtrace real-run download payload");
      return;
    }
    if (req.url === "/api/search" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": `${rawCookieName}=${rawCookieValue}; HttpOnly; Path=/; SameSite=Lax`
        });
        res.end(JSON.stringify({
          rows: ["alpha-real-run", "beta-real-run"],
          received: Buffer.concat(chunks).toString("utf8")
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket) => {
    socket.on("message", (message) => {
      socket.send(`echo:${message.toString()}`);
    });
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.url === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
      return;
    }
    socket.destroy();
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Demo app should have a TCP address");

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolveClose) => wss.close(() => resolveClose()));
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    }
  };
}

function indexHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>RawTrace Real Run</title>
</head>
<body>
  <h1 aria-label="RawTrace Real Run Heading">RawTrace Real Run</h1>
  <input id="query" value="">
  <input id="space-placeholder" placeholder="First  name" value="">
  <select id="choice" aria-label="Choice">
    <option value="">Choose</option>
    <option value="alpha">Alpha</option>
    <option value="beta">Beta</option>
  </select>
  <form id="profile-form" aria-label="Profile Form">
    <label for="profile-name">Profile Name</label>
    <input id="profile-name" name="profileName" value="">
    <label for="profile-notes">Profile Notes</label>
    <textarea id="profile-notes" name="profileNotes"></textarea>
    <label for="profile-tier">Profile Tier</label>
    <select id="profile-tier" name="profileTier">
      <option value="free">Free</option>
      <option value="pro">Pro</option>
    </select>
    <label><input id="profile-enabled" name="profileEnabled" type="checkbox"> Enabled</label>
    <input id="upload-file" name="uploadFile" type="file">
    <button id="profile-submit" type="submit">Save Profile</button>
  </form>
  <label><input id="agree" type="checkbox"> Agree</label>
  <button id="submit" type="button">Submit</button>
  <button id="dialog-button" type="button">Dialog</button>
  <button id="delayed-button" type="button">Delayed API</button>
  <button id="response-body-button" type="button">Response Body API</button>
  <button id="geolocation-button" type="button">Read Location</button>
  <a id="download-link" href="/download/report.txt" download>Download Report</a>
  <a id="second-link" href="/second">Second</a>
  <a id="popup-link" href="/second" target="_blank">Popup</a>
  <div id="hover-target" role="button" tabindex="0">Hover Target</div>
  <section id="selector-lab" aria-label="Selector Lab">
    <div data-testid="selector-first-card">
      <h3>Selector First</h3>
      <button type="button" class="rounded bg-blue-600 px-2">Duplicate Action</button>
    </div>
    <div>
      <h3>Selector Target</h3>
      <button id="base-ui-_r_dynamic" type="button" class="rounded bg-blue-600 px-2">Duplicate Action</button>
    </div>
  </section>
  <section id="checkin-selector-lab" aria-label="Checkin Selector Lab">
    <h3>每日签到</h3>
    <button type="button">立即签到</button>
  </section>
  <div id="status">idle</div>
  <ul id="results"></ul>
  <div style="height:1200px">scroll area</div>
  <button id="bottom-button" type="button">Bottom</button>
  <script>
    const input = document.querySelector("#query");
    const button = document.querySelector("#submit");
    const status = document.querySelector("#status");
    const results = document.querySelector("#results");
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") status.textContent = "pressed-enter";
    });
    document.querySelector("#choice").addEventListener("change", (event) => {
      status.textContent = "choice:" + event.target.value;
    });
    document.querySelector("#agree").addEventListener("change", (event) => {
      status.textContent = "agree:" + event.target.checked;
    });
    document.querySelector("#hover-target").addEventListener("mouseenter", (event) => {
      event.currentTarget.classList.add("hovered");
      status.textContent = "hovered";
    });
    document.querySelector("#dialog-button").addEventListener("click", () => {
      alert("rawtrace real-run dialog");
    });
    document.querySelector("#delayed-button").addEventListener("click", async () => {
      const response = await fetch("/api/delayed");
      const data = await response.json();
      status.textContent = data.marker;
    });
    document.querySelector("#response-body-button").addEventListener("click", async () => {
      const response = await fetch("/api/response-body");
      const data = await response.json();
      status.textContent = data.marker;
    });
    document.querySelector("#geolocation-button").addEventListener("click", () => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          status.textContent = "geo:" + position.coords.latitude.toFixed(3) + "," + position.coords.longitude.toFixed(3);
        },
        (error) => {
          status.textContent = "geo-error:" + error.code;
        }
      );
    });
    document.querySelector("#profile-form").addEventListener("submit", (event) => {
      event.preventDefault();
      status.textContent =
        "profile:" +
        document.querySelector("#profile-name").value +
        ":" +
        document.querySelector("#profile-tier").value +
        ":" +
        document.querySelector("#profile-enabled").checked;
    });
    button.addEventListener("click", async () => {
      console.log("rawtrace-console-log-12345");
      console.error(${JSON.stringify(consoleErrorText)});
      setTimeout(() => { throw new Error("rawtrace-page-error-12345"); }, 0);

      button.classList.add("loading");
      status.textContent = "loading";

      const transient = document.createElement("div");
      transient.id = "transient";
      transient.textContent = ${JSON.stringify(transientText)};
      document.body.appendChild(transient);
      setTimeout(() => transient.remove(), 50);

      const iframe = document.createElement("iframe");
      iframe.id = "rawtrace-frame";
      iframe.src = "/frame?run=12345";
      document.body.appendChild(iframe);

      const ws = new WebSocket("ws://" + location.host + "/ws");
      ws.addEventListener("open", () => ws.send(${JSON.stringify(wsPayload)}));
      ws.addEventListener("message", (event) => {
        status.textContent = event.data;
      });

      const response = await fetch("/api/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rawtrace-real-run": "raw-header-12345"
        },
        body: JSON.stringify({
          query: document.querySelector("#query").value,
          token: ${JSON.stringify(rawToken)}
        })
      });
      const data = await response.json();
      results.innerHTML = "";
      for (const row of data.rows) {
        const li = document.createElement("li");
        li.className = "row";
        li.textContent = row;
        results.appendChild(li);
      }
      button.classList.remove("loading");
    });
  </script>
</body>
</html>`;
}

function secondHtml() {
  return `<!doctype html>
<html>
<head><title>RawTrace Second Page</title></head>
<body>
  <h1>Second Page</h1>
  <a id="back-home" href="/">Home</a>
</body>
</html>`;
}

function frameHtml() {
  return `<!doctype html>
<html>
<body>
  <div id="frame-content">rawtrace-frame-content-12345</div>
  <script>console.log("rawtrace-frame-console-12345");</script>
</body>
</html>`;
}

async function getFreePort() {
  const server = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Free port probe should have a TCP address");
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose())));
  return port;
}

async function canConnectHttp(port) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "GET" }).catch(() => undefined);
  return response !== undefined;
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function runProcess(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code, signal) => {
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return;
  }
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit())),
    delay(timeoutMs).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    })
  ]);
}

function timestampForPath() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
}

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
