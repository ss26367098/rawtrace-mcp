import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

      expect(String(state.url)).toContain(demo.url);
      expect(state).toMatchObject({
        title: "RawTrace Demo",
        readyState: expect.any(String)
      });
      expect(JSON.stringify(buttonDom)).toContain("Submit");
      expect(JSON.stringify(elements)).toContain("#submit");
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
