import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { RawTraceRuntime } from "../../src/runtime/browserRuntime.js";
import { startDemoServer, type DemoServer } from "../fixtures/demoServer.js";

describe("RawTraceRuntime integration", () => {
  let demo: DemoServer;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    demo = await startDemoServer();
  });

  afterAll(async () => {
    await demo.close();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("records DOM, network, cookies, WebSocket, and action events", async () => {
    const runtime = new RawTraceRuntime();
    const outputBase = await mkdtemp(join(tmpdir(), "rawtrace-integration-"));
    tempDirs.push(outputBase);

    await runtime.browserLaunch({ headless: true });
    await runtime.browserNavigate({ url: demo.url, waitUntil: "domcontentloaded" });
    const start = await runtime.monitorStart({ acknowledgeRawCapture: true, outputDir: outputBase });
    await runtime.browserType({ selector: "#query", text: "abc" });
    await runtime.browserClick({ selector: "#submit" });
    await runtime.browserWait({ mode: "quiet", quietMs: 250, timeoutMs: 5000 });
    const stop = await runtime.monitorStop();
    await runtime.browserClose();

    expect(stop.eventCounts).toMatchObject({
      actions: expect.any(Number),
      dom: expect.any(Number),
      network: expect.any(Number),
      cookies: expect.any(Number),
      websocket: expect.any(Number)
    });

    const sessionId = String(start.sessionId);
    const dom = await runtime.monitorReadEvents({ sessionId, stream: "dom", limit: 1000 });
    const network = await runtime.monitorReadEvents({ sessionId, stream: "network", limit: 1000 });
    const cookies = await runtime.monitorReadEvents({ sessionId, stream: "cookies", limit: 1000 });
    const websocket = await runtime.monitorReadEvents({ sessionId, stream: "websocket", limit: 1000 });
    const summary = await runtime.monitorGetSummary({ sessionId });
    const domSearch = await runtime.monitorSearchEvents({ sessionId, stream: "dom", text: "short lived" });
    const networkSearch = await runtime.monitorSearchEvents({ sessionId, stream: "network", urlContains: "/api/search" });
    const recentNetwork = await runtime.browserGetNetwork({ sessionId, limit: 1 });

    expect(JSON.stringify(dom.events)).toContain("short lived");
    expect(JSON.stringify(network.events)).toContain("/api/search");
    expect(JSON.stringify(network.events)).toContain("raw-csrf-demo");
    expect(JSON.stringify(cookies.events)).toContain("rawtrace_demo");
    expect(JSON.stringify(websocket.events)).toContain("clicked");
    expect(summary.highlights).toBeDefined();
    expect(JSON.stringify(domSearch)).toContain("short lived");
    expect(JSON.stringify(networkSearch)).toContain("/api/search");
    expect((recentNetwork.events as Array<{ seq: number }>)[0]?.seq).toBe(
      Math.max(...(network.events as Array<{ seq: number }>).map((event) => event.seq))
    );
  }, 30_000);

  it("records failed actions as action error events", async () => {
    const runtime = new RawTraceRuntime();
    const outputBase = await mkdtemp(join(tmpdir(), "rawtrace-integration-"));
    tempDirs.push(outputBase);
    let sessionId = "";

    try {
      await runtime.browserLaunch({ headless: true });
      await runtime.browserNavigate({ url: demo.url, waitUntil: "domcontentloaded" });
      const start = await runtime.monitorStart({ acknowledgeRawCapture: true, outputDir: outputBase });
      sessionId = String(start.sessionId);

      await expect(runtime.browserClick({ selector: "#does-not-exist", timeoutMs: 100 })).rejects.toThrow();
      await runtime.monitorStop();

      const actions = await runtime.monitorReadEvents({ sessionId, stream: "actions", limit: 100 });
      expect(JSON.stringify(actions.events)).toContain("click.start");
      expect(JSON.stringify(actions.events)).toContain("click.error");
    } finally {
      await runtime.browserClose().catch(() => undefined);
    }
  }, 30_000);

  it("inspects current page state, DOM, elements, screenshots, and body files", async () => {
    const runtime = new RawTraceRuntime();
    const outputBase = await mkdtemp(join(tmpdir(), "rawtrace-integration-"));
    tempDirs.push(outputBase);

    try {
      await runtime.browserLaunch({ headless: true });
      await runtime.browserNavigate({ url: demo.url, waitUntil: "domcontentloaded" });

      const state = await runtime.browserGetState({ acknowledgeRawCapture: true });
      const buttonDom = await runtime.browserGetDom({
        acknowledgeRawCapture: true,
        selector: "#submit",
        mode: "both"
      });
      const largeDom = await runtime.browserGetDom({
        acknowledgeRawCapture: true,
        mode: "html",
        maxBytes: 10
      });
      const elements = await runtime.browserGetElements({
        acknowledgeRawCapture: true,
        textContains: "Submit"
      });
      const snapshot = await runtime.browserSnapshot({
        acknowledgeRawCapture: true,
        elementsLimit: 10
      });
      const largeSnapshot = await runtime.browserSnapshot({
        acknowledgeRawCapture: true,
        maxTextBytes: 10
      });
      const dataTestElements = await runtime.browserGetElements({
        acknowledgeRawCapture: true,
        textContains: "Data Test Action"
      });
      const optimizedSubmit = await runtime.browserOptimizeSelector({
        acknowledgeRawCapture: true,
        selector: "#submit"
      });
      const optimizedDuplicate = await runtime.browserOptimizeSelector({
        acknowledgeRawCapture: true,
        selector: "#selector-lab > div:nth-of-type(2) > button",
        textContains: "Duplicate Action",
        includeRejected: true
      });
      const optimizedCheckin = await runtime.browserOptimizeSelector({
        acknowledgeRawCapture: true,
        selector: "#checkin-selector-lab button",
        textContains: "签到",
        includeRejected: true
      });
      const optimizedSpacePlaceholder = await runtime.browserOptimizeSelector({
        acknowledgeRawCapture: true,
        selector: "#space-placeholder",
        includeRejected: true
      });
      const disabledElements = await runtime.browserGetElements({
        acknowledgeRawCapture: true,
        textContains: "Disabled Action"
      });
      const screenshot = await runtime.browserScreenshot({
        acknowledgeRawCapture: true,
        fullPage: true
      });
      const annotatedScreenshot = await runtime.browserScreenshotAnnotated({
        acknowledgeRawCapture: true,
        selector: "#submit"
      });

      expect(String(state.url)).toContain(demo.url);
      expect(state).toMatchObject({
        title: "RawTrace Demo",
        readyState: expect.any(String)
      });
      expect(JSON.stringify(buttonDom)).toContain("Submit");
      expect(JSON.stringify(elements)).toContain("#submit");
      expect(elements.elements).toEqual([
        expect.objectContaining({
          id: "submit",
          recommendedSelector: "#submit",
          selectorUnique: true,
          enabled: true,
          clickable: true,
          stableSelectorScore: expect.any(Number)
        })
      ]);
      expect(JSON.stringify(snapshot)).toContain("RawTrace Demo");
      expect(JSON.stringify(snapshot)).toContain("activeElement");
      expect(String((largeSnapshot.text as { outputPath?: string }).outputPath)).toContain("rawtrace-traces");
      expect(JSON.stringify(dataTestElements)).toContain('[data-test=\\"data-test-action\\"]');
      expect(JSON.stringify(dataTestElements)).not.toContain('[data-testid=\\"data-test-action\\"]');
      expect(JSON.stringify(optimizedSubmit)).toContain("#submit");
      expect(JSON.stringify(optimizedDuplicate)).toContain("Selector Target");
      expect(JSON.stringify(optimizedDuplicate)).toContain("not_unique");
      expect(JSON.stringify((optimizedDuplicate.recommended as { selector?: string })?.selector)).not.toContain("base-ui-_r_dynamic");
      expect(String((optimizedCheckin.recommended as { selector?: string })?.selector)).toContain("立即签到");
      expect(String((optimizedCheckin.recommended as { selector?: string })?.selector)).not.toBe('button:has-text("签到")');
      const spacePlaceholderCandidates = optimizedSpacePlaceholder.candidates as Array<{ selector?: string }>;
      expect(spacePlaceholderCandidates.some((candidate) => candidate.selector === 'input[placeholder="First  name"]')).toBe(true);
      expect(spacePlaceholderCandidates.some((candidate) => candidate.selector === 'input[placeholder="First name"]')).toBe(false);
      expect(disabledElements.elements).toEqual([
        expect.objectContaining({
          id: "aria-disabled-action",
          disabled: true
        })
      ]);
      expect(String((largeDom.html as { outputPath?: string }).outputPath)).toContain("rawtrace-traces");
      await expect(readFile(String((largeDom.html as { outputPath: string }).outputPath), "utf8")).resolves.toContain("RawTrace Demo");
      await expect(stat(String(screenshot.outputPath))).resolves.toMatchObject({ size: expect.any(Number) });
      await expect(stat(String(annotatedScreenshot.outputPath))).resolves.toMatchObject({ size: expect.any(Number) });

      const start = await runtime.monitorStart({ acknowledgeRawCapture: true, outputDir: outputBase });
      await runtime.browserGetDom({
        acknowledgeRawCapture: true,
        selector: "#submit",
        mode: "text"
      });
      await runtime.browserType({ selector: "#query", text: "body-search-token" });
      await runtime.browserClick({ selector: "#submit" });
      await runtime.browserWait({ mode: "quiet", quietMs: 250, timeoutMs: 5000 });
      await runtime.monitorStop();

      const actions = await runtime.monitorReadEvents({ sessionId: String(start.sessionId), stream: "actions", limit: 1000 });
      const bodySearch = await runtime.monitorSearchBodies({
        acknowledgeRawCapture: true,
        sessionId: String(start.sessionId),
        text: "body-search-token",
        urlContains: "/api/search",
        status: 200
      });

      expect(JSON.stringify(actions.events)).toContain("inspect.get_dom.start");
      expect(JSON.stringify(actions.events)).toContain("inspect.get_dom.end");
      expect(JSON.stringify(actions.events)).not.toContain("<!doctype html>");
      expect(JSON.stringify(bodySearch)).toContain("/api/search");
      expect(JSON.stringify(bodySearch)).toContain("body-search-token");
    } finally {
      await runtime.browserClose().catch(() => undefined);
    }
  }, 30_000);

  it("polls snapshots and observes action result diffs", async () => {
    const runtime = new RawTraceRuntime();

    try {
      await runtime.browserLaunch({ headless: true });
      await runtime.browserNavigate({ url: demo.url, waitUntil: "domcontentloaded" });

      const textPoll = await runtime.browserPollUntil({
        acknowledgeRawCapture: true,
        timeoutMs: 3000,
        intervalMs: 250,
        conditions: [{ type: "text", text: "RawTrace Demo" }]
      });
      const observedType = await runtime.browserObserveActionResult({
        acknowledgeRawCapture: true,
        action: { type: "type", selector: "#query", text: "observed input value" },
        beforeSnapshot: { elementsLimit: 10 },
        afterSnapshot: { elementsLimit: 10 },
        waitAfterMs: 100
      });
      const valuePoll = await runtime.browserPollUntil({
        acknowledgeRawCapture: true,
        timeoutMs: 3000,
        intervalMs: 250,
        conditions: [{ type: "elementValue", selector: "#query", contains: "observed input" }]
      });
      const observedEval = await runtime.browserObserveActionResult({
        acknowledgeRawCapture: true,
        acknowledgeDangerousEval: true,
        action: {
          type: "eval",
          acknowledgeRawCapture: true,
          acknowledgeDangerousEval: true,
          expression: "document.querySelector('#status').textContent = 'observed eval status'; 'ok'"
        },
        waitAfterMs: 100
      });

      expect(textPoll).toMatchObject({ matched: true });
      expect(JSON.stringify(textPoll.samples)).toContain("RawTrace Demo");
      expect(valuePoll).toMatchObject({ matched: true });
      expect(observedType.diff).toMatchObject({
        inputValues: expect.objectContaining({ changed: true })
      });
      expect(JSON.stringify(observedEval.diff)).toContain("observed eval status");
    } finally {
      await runtime.browserClose().catch(() => undefined);
    }
  }, 30_000);

  it("returns structured selector optimization errors", async () => {
    const runtime = new RawTraceRuntime();

    try {
      await runtime.browserLaunch({ headless: true });
      await runtime.browserNavigate({ url: demo.url, waitUntil: "domcontentloaded" });
      await expect(runtime.browserOptimizeSelector({ selector: "#submit" })).rejects.toThrow("acknowledgeRawCapture");
      await expect(
        runtime.browserOptimizeSelector({
          acknowledgeRawCapture: true,
          selector: "#does-not-exist"
        })
      ).rejects.toMatchObject({ code: "ELEMENT_NOT_FOUND" });
      await expect(
        runtime.browserOptimizeSelector({
          acknowledgeRawCapture: true,
          selector: "button",
          targetIndex: 999
        })
      ).rejects.toMatchObject({ code: "TARGET_INDEX_OUT_OF_RANGE" });
    } finally {
      await runtime.browserClose().catch(() => undefined);
    }
  }, 30_000);

  it("records body skip metadata when maxBodyBytes is exceeded", async () => {
    const runtime = new RawTraceRuntime();
    const outputBase = await mkdtemp(join(tmpdir(), "rawtrace-integration-"));
    tempDirs.push(outputBase);

    try {
      await runtime.browserLaunch({ headless: true });
      await runtime.browserNavigate({ url: demo.url, waitUntil: "domcontentloaded" });
      const start = await runtime.monitorStart({ acknowledgeRawCapture: true, outputDir: outputBase, maxBodyBytes: 10 });
      await runtime.browserType({ selector: "#query", text: "abc" });
      await runtime.browserClick({ selector: "#submit" });
      await runtime.browserWait({ mode: "quiet", quietMs: 250, timeoutMs: 5000 });
      await runtime.monitorStop();

      const network = await runtime.monitorReadEvents({ sessionId: String(start.sessionId), stream: "network", limit: 1000 });
      expect(JSON.stringify(network.events)).toContain("bodySkipped");
      expect(JSON.stringify(network.events)).toContain("maxBodyBytes");
    } finally {
      await runtime.browserClose().catch(() => undefined);
    }
  }, 30_000);

  it("supports expanded browser controls, tabs, eval, network summaries, and credential state tools", async () => {
    const runtime = new RawTraceRuntime();
    const outputBase = await mkdtemp(join(tmpdir(), "rawtrace-integration-"));
    const storageStatePath = join(outputBase, "storage-state.json");
    tempDirs.push(outputBase);

    try {
      await runtime.browserLaunch({ headless: true });
      await runtime.browserNavigate({ url: demo.url, waitUntil: "domcontentloaded" });
      const initialTabs = await runtime.browserListTabs();
      const initialPageId = String((initialTabs.pages as Array<{ pageId: string }>)[0]?.pageId);
      const start = await runtime.monitorStart({ acknowledgeRawCapture: true, outputDir: outputBase });

      await runtime.browserHandleDialog({ action: "accept" });
      await runtime.browserClick({ selector: "#dialog-button" });
      await runtime.browserHover({ selector: "#hover-target" });
      await runtime.browserSelectOption({ selector: "#choice", values: "beta" });
      await runtime.browserCheck({ selector: "#agree", checked: true });
      await runtime.browserType({ selector: "#query", text: "press target" });
      await runtime.browserPress({ selector: "#query", key: "Enter" });

      const delayedResponse = runtime.browserWaitForResponse({ urlContains: "/api/delayed", status: 200, method: "GET" });
      await runtime.browserClick({ selector: "#delayed-button" });
      await expect(delayedResponse).resolves.toMatchObject({
        status: 200,
        method: "GET"
      });

      await runtime.browserScroll({ selector: "#bottom-button", deltaY: 800 });
      const accessibility = await runtime.browserGetAccessibility({ acknowledgeRawCapture: true, textContains: "RawTrace Demo" });
      const evalResult = await runtime.browserEval({
        acknowledgeRawCapture: true,
        acknowledgeDangerousEval: true,
        expression: "({ status: document.querySelector('#status')?.textContent, local: localStorage.getItem('rawtrace-key') })"
      });
      const largeEvalResult = await runtime.browserEval({
        acknowledgeRawCapture: true,
        acknowledgeDangerousEval: true,
        expression: "'x'.repeat(70000)",
        maxBytes: 10
      });

      await runtime.browserSetStorage({
        acknowledgeRawCapture: true,
        acknowledgeCredentialAccess: true,
        localStorage: { "rawtrace-key": "rawtrace-value" },
        sessionStorage: { "rawtrace-session": "session-value" }
      });
      const storage = await runtime.browserGetStorage({
        acknowledgeRawCapture: true,
        acknowledgeCredentialAccess: true
      });
      const exportedStorage = await runtime.browserExportStorageState({
        acknowledgeRawCapture: true,
        acknowledgeCredentialAccess: true,
        outputPath: storageStatePath
      });
      await runtime.browserSetCookies({
        acknowledgeRawCapture: true,
        acknowledgeCredentialAccess: true,
        cookies: [
          {
            name: "rawtrace_runtime_cookie",
            value: "cookie-value",
            url: demo.url
          }
        ]
      });
      const cookies = await runtime.browserGetCookies({
        acknowledgeRawCapture: true,
        acknowledgeCredentialAccess: true,
        urls: [demo.url]
      });
      await runtime.browserClearCookies({
        acknowledgeRawCapture: true,
        acknowledgeCredentialAccess: true,
        name: "rawtrace_runtime_cookie"
      });
      await runtime.browserImportStorageState({
        acknowledgeRawCapture: true,
        acknowledgeCredentialAccess: true,
        path: storageStatePath
      });

      const network = await runtime.browserGetNetwork({
        sessionId: String(start.sessionId),
        urlContains: "/api/delayed",
        status: 200
      });

      await runtime.browserNavigate({ url: `${demo.url}/second`, waitUntil: "domcontentloaded" });
      const back = await runtime.browserGoBack();
      const forward = await runtime.browserGoForward();
      const reload = await runtime.browserReload();
      const newTab = await runtime.browserNewTab({ url: `${demo.url}/second`, waitUntil: "domcontentloaded" });
      const tabsAfterNew = await runtime.browserListTabs();
      await runtime.browserSwitchTab({ pageId: initialPageId });
      await runtime.browserCloseTab({ pageId: String(newTab.pageId) });
      const tabsAfterClose = await runtime.browserListTabs();

      await runtime.monitorStop();

      expect(JSON.stringify(accessibility)).toContain("heading");
      expect(JSON.stringify(evalResult)).toContain("delayed-response");
      expect(String((largeEvalResult.result as { outputPath?: string }).outputPath)).toContain(outputBase);
      expect(JSON.stringify(storage)).toContain("rawtrace-value");
      expect((exportedStorage.state as { outputPath?: string }).outputPath).toBe(storageStatePath);
      await expect(readFile(storageStatePath, "utf8")).resolves.toContain("rawtrace-key");
      expect(JSON.stringify(cookies)).toContain("rawtrace_runtime_cookie");
      expect(JSON.stringify(network)).toContain("/api/delayed");
      expect(String(back.url)).toBe(demo.url + "/");
      expect(String(forward.url)).toBe(`${demo.url}/second`);
      expect(String(reload.url)).toBe(`${demo.url}/second`);
      expect((tabsAfterNew.pages as unknown[]).length).toBeGreaterThanOrEqual(2);
      expect((tabsAfterClose.pages as unknown[]).length).toBe(1);
    } finally {
      await runtime.browserClose().catch(() => undefined);
    }
  }, 60_000);

  it("supports artifact reads, response bodies, downloads, uploads, viewport, permissions, geolocation, and forms", async () => {
    const runtime = new RawTraceRuntime();
    const outputBase = await mkdtemp(join(tmpdir(), "rawtrace-integration-"));
    const uploadPath = join(outputBase, "upload-token.txt");
    tempDirs.push(outputBase);
    await writeFile(uploadPath, "rawtrace upload payload", "utf8");

    try {
      await runtime.browserLaunch({ headless: true });
      await runtime.browserNavigate({ url: demo.url, waitUntil: "domcontentloaded" });

      const viewport = await runtime.browserSetViewport({ width: 640, height: 480 });
      const stateAfterViewport = await runtime.browserGetState({ acknowledgeRawCapture: true });
      const started = await runtime.monitorStart({ acknowledgeRawCapture: true, outputDir: outputBase });
      const sessionId = String(started.sessionId);
      const sessionsWhileRunning = await runtime.monitorListSessions();
      const manifestWhileRunning = await runtime.monitorGetManifest({ sessionId });
      const largeDom = await runtime.browserGetDom({
        acknowledgeRawCapture: true,
        mode: "html",
        maxBytes: 10
      });
      const artifact = await runtime.monitorReadArtifact({
        acknowledgeRawCapture: true,
        sessionId,
        ref: (largeDom.html as { ref: { path: string; byteLength: number; sha256: string; encoding: "utf8" } }).ref,
        asText: true
      });

      const responseBodyPromise = runtime.browserWaitForResponseBody({
        acknowledgeRawCapture: true,
        urlContains: "/api/response-body",
        method: "GET",
        status: 200,
        parseJson: true
      });
      await runtime.browserClick({ selector: "#response-body-button" });
      const responseBody = await responseBodyPromise;
      const largeResponsePromise = runtime.browserWaitForResponseBody({
        acknowledgeRawCapture: true,
        urlContains: "/api/large-response",
        method: "GET",
        status: 200,
        maxBytes: 10
      });
      await runtime.browserClick({ selector: "#large-response-button" });
      const largeResponse = await largeResponsePromise;

      const formsBefore = await runtime.browserGetForms({
        acknowledgeRawCapture: true,
        textContains: "Profile",
        limit: 10
      });
      const formsFromContainer = await runtime.browserGetForms({
        acknowledgeRawCapture: true,
        selector: "#form-container",
        textContains: "Profile",
        limit: 10
      });
      await runtime.browserEval({
        acknowledgeRawCapture: true,
        acknowledgeDangerousEval: true,
        expression: "document.querySelector('#profile-notes').value = 'x'.repeat(70000); true"
      });
      const largeForms = await runtime.browserGetForms({
        acknowledgeRawCapture: true,
        selector: "#profile-form",
        maxBytes: 10
      });
      const largeFormsArtifact = await runtime.monitorReadArtifact({
        acknowledgeRawCapture: true,
        sessionId,
        ref: (largeForms as { formsRef: { path: string; byteLength: number; sha256: string; encoding: "utf8" } }).formsRef,
        parseJson: true,
        maxBytes: 200_000
      });
      const fillResult = await runtime.browserFillForm({
        fields: [
          { name: "profileName", value: "Ada" },
          { label: "Profile Notes", value: "note body" },
          { selector: "#profile-tier", value: "pro" },
          { selector: "#profile-enabled", checked: true }
        ],
        submitSelector: "#profile-submit"
      });
      const statusDom = await runtime.browserGetDom({
        acknowledgeRawCapture: true,
        selector: "#status",
        mode: "text"
      });

      const uploadResult = await runtime.browserUploadFile({
        acknowledgeFileAccess: true,
        selector: "#upload-file",
        paths: [uploadPath]
      });
      const uploadedForms = await runtime.browserGetForms({
        acknowledgeRawCapture: true,
        selector: "#upload-file"
      });

      const download = await runtime.browserWaitForDownload({
        acknowledgeRawCapture: true,
        triggerSelector: "#download-link",
        outputDir: join(outputBase, "downloads")
      });
      const downloads = await runtime.browserGetDownloads({ limit: 10 });

      await runtime.browserGrantPermissions({
        acknowledgePermissionChange: true,
        permissions: ["geolocation"],
        origin: demo.url
      });
      await runtime.browserSetGeolocation({
        acknowledgeLocationAccess: true,
        latitude: 22.3193,
        longitude: 114.1694,
        accuracy: 10
      });
      await runtime.browserClick({ selector: "#geolocation-button" });
      await runtime.browserWait({ mode: "quiet", quietMs: 100, timeoutMs: 3000 });
      const geoStatus = await runtime.browserGetDom({
        acknowledgeRawCapture: true,
        selector: "#status",
        mode: "text"
      });

      await runtime.monitorStop();
      const sessionsAfterStop = await runtime.monitorListSessions();

      expect(viewport.viewport).toEqual({ width: 640, height: 480 });
      expect(stateAfterViewport.viewport).toEqual({ width: 640, height: 480 });
      expect(JSON.stringify(sessionsWhileRunning)).toContain(sessionId);
      expect(manifestWhileRunning).toMatchObject({ sessionId, status: "running" });
      expect(JSON.stringify(artifact)).toContain("RawTrace Demo");
      expect(JSON.stringify(responseBody)).toContain("RAW_RESPONSE_BODY_TOKEN");
      expect(largeResponse.body).toMatchObject({
        contentSkippedReason: "contentLength_exceeds_maxBytes",
        truncated: true
      });
      expect(JSON.stringify(formsBefore)).toContain("profileName");
      expect(JSON.stringify(formsFromContainer)).toContain("profileName");
      expect(largeForms).toMatchObject({
        totalForms: 1,
        totalControls: expect.any(Number),
        formsRef: expect.any(Object)
      });
      expect(JSON.stringify(largeFormsArtifact)).toContain("profileNotes");
      expect(fillResult).toMatchObject({ filledCount: 4, submitted: true });
      expect(JSON.stringify(statusDom)).toContain("profile:Ada:pro:true");
      expect(uploadResult).toMatchObject({ uploaded: true, fileCount: 1 });
      expect(JSON.stringify(uploadedForms)).toContain("upload-token.txt");
      await expect(readFile(String(download.outputPath), "utf8")).resolves.toBe("rawtrace download payload");
      expect(JSON.stringify(downloads)).toContain(String(download.downloadId));
      expect(JSON.stringify(geoStatus)).toContain("geo:22.319,114.169");
      expect(JSON.stringify(sessionsAfterStop)).toContain('"status":"stopped"');
    } finally {
      await runtime.browserClose().catch(() => undefined);
    }
  }, 60_000);

  it("protects explicit profiles from storageState overwrite without explicit acknowledgment", async () => {
    const runtime = new RawTraceRuntime();
    const userDataDir = await mkdtemp(join(tmpdir(), "rawtrace-explicit-profile-"));
    const statePath = join(userDataDir, "state.json");
    tempDirs.push(userDataDir);
    await writeFile(
      statePath,
      JSON.stringify({
        cookies: [],
        origins: [
          {
            origin: demo.url,
            localStorage: [{ name: "protected-key", value: "protected-value" }]
          }
        ]
      }),
      "utf8"
    );

    try {
      await runtime.browserLaunch({ headless: true, userDataDir });
      await runtime.browserNavigate({ url: demo.url, waitUntil: "domcontentloaded" });
      await expect(
        runtime.browserImportStorageState({
          acknowledgeRawCapture: true,
          acknowledgeCredentialAccess: true,
          path: statePath
        })
      ).rejects.toMatchObject({
        code: "STORAGE_STATE_OVERWRITE_ACK_REQUIRED"
      });
      await runtime.browserImportStorageState({
        acknowledgeRawCapture: true,
        acknowledgeCredentialAccess: true,
        acknowledgeStorageStateOverwrite: true,
        path: statePath
      });
      const storage = await runtime.browserGetStorage({
        acknowledgeRawCapture: true,
        acknowledgeCredentialAccess: true
      });
      expect(JSON.stringify(storage)).toContain("protected-value");
    } finally {
      await runtime.browserClose().catch(() => undefined);
    }
  }, 30_000);

  it("attaches to a CDP browser and selects a tab by URL", async () => {
    const runtime = new RawTraceRuntime();
    const userDataDir = await mkdtemp(join(tmpdir(), "rawtrace-cdp-profile-"));
    const port = await getFreePort();
    tempDirs.push(userDataDir);
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: [`--remote-debugging-port=${port}`]
    });

    try {
      const firstPage = context.pages()[0] ?? (await context.newPage());
      await firstPage.goto(demo.url, { waitUntil: "domcontentloaded" });
      const secondPage = await context.newPage();
      await secondPage.goto(`${demo.url}/second`, { waitUntil: "domcontentloaded" });

      const attached = await runtime.browserAttachCdp({
        cdpUrl: `http://127.0.0.1:${port}`,
        urlContains: "/second"
      });

      expect(attached).toMatchObject({
        mode: "cdp",
        activePage: expect.objectContaining({
          url: `${demo.url}/second`
        })
      });
      expect((attached.tabs as unknown[]).length).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime.browserClose().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }, 30_000);

  it("cleans up runtime state when CDP tab selection fails", async () => {
    const runtime = new RawTraceRuntime();
    const userDataDir = await mkdtemp(join(tmpdir(), "rawtrace-cdp-profile-"));
    const port = await getFreePort();
    tempDirs.push(userDataDir);
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: [`--remote-debugging-port=${port}`]
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(demo.url, { waitUntil: "domcontentloaded" });

      await expect(
        runtime.browserAttachCdp({
          cdpUrl: `http://127.0.0.1:${port}`,
          urlContains: "/missing-tab"
        })
      ).rejects.toMatchObject({
        code: "TARGET_INDEX_OUT_OF_RANGE"
      });
      await expect(runtime.browserGetState({ acknowledgeRawCapture: true })).rejects.toMatchObject({
        code: "BROWSER_NOT_LAUNCHED"
      });
    } finally {
      await runtime.browserClose().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }, 30_000);

  it("recovers by closing the active page when browser_eval times out", async () => {
    const runtime = new RawTraceRuntime();

    try {
      await runtime.browserLaunch({ headless: true });
      await runtime.browserNavigate({ url: demo.url, waitUntil: "domcontentloaded" });
      await expect(
        runtime.browserEval({
          acknowledgeRawCapture: true,
          acknowledgeDangerousEval: true,
          expression: "new Promise(() => {})",
          timeoutMs: 50
        })
      ).rejects.toMatchObject({
        code: "OPERATION_TIMEOUT",
        details: expect.objectContaining({
          recovery: "closed_page"
        })
      });
      const tabs = await runtime.browserListTabs();
      expect((tabs.pages as Array<{ active: boolean }>).some((page) => page.active)).toBe(true);
    } finally {
      await runtime.browserClose().catch(() => undefined);
    }
  }, 30_000);
});

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}
