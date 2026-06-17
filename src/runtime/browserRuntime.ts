import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Cookie, Dialog, ElementHandle, Frame, Locator, Page } from "playwright";
import {
  CREDENTIAL_ACCESS_WARNING,
  DANGEROUS_EVAL_WARNING,
  DEFAULT_ACCESSIBILITY_LIMIT,
  DEFAULT_GET_DOWNLOADS_LIMIT,
  DEFAULT_GET_ELEMENTS_LIMIT,
  DEFAULT_GET_FORMS_LIMIT,
  DEFAULT_GET_NETWORK_LIMIT,
  DEFAULT_INSPECTION_MAX_BYTES,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_READ_EVENTS_LIMIT,
  FILE_ACCESS_WARNING,
  LOCATION_ACCESS_WARNING,
  MAX_ACCESSIBILITY_LIMIT,
  MAX_GET_DOWNLOADS_LIMIT,
  MAX_GET_ELEMENTS_LIMIT,
  MAX_GET_FORMS_LIMIT,
  MAX_GET_NETWORK_LIMIT,
  PERMISSION_CHANGE_WARNING,
  RAW_CAPTURE_WARNING,
  STORAGE_STATE_OVERWRITE_WARNING
} from "../constants.js";
import { RawTraceError } from "../errors.js";
import { ConsoleRecorder } from "../recorders/consoleRecorder.js";
import { CookieRecorder } from "../recorders/cookieRecorder.js";
import { DomRecorder } from "../recorders/domRecorder.js";
import { FrameRecorder } from "../recorders/frameRecorder.js";
import { NetworkRecorder } from "../recorders/networkRecorder.js";
import { WebSocketRecorder } from "../recorders/webSocketRecorder.js";
import { summarizeTrace } from "../trace/summary.js";
import type { TraceSummary } from "../trace/summary.js";
import { TraceSession } from "../trace/session.js";
import type {
  BodyRef,
  BrowserCheckInput,
  BrowserClearCookiesInput,
  BrowserEvalInput,
  BrowserExportStorageStateInput,
  BrowserFillFormInput,
  BrowserGetDomInput,
  BrowserGetElementsInput,
  BrowserGetDownloadsInput,
  BrowserGetFormsInput,
  BrowserGetAccessibilityInput,
  BrowserGetCookiesInput,
  BrowserGetNetworkInput,
  BrowserGetStateInput,
  BrowserGetStorageInput,
  BrowserGrantPermissionsInput,
  BrowserHandleDialogInput,
  BrowserHoverInput,
  BrowserImportStorageStateInput,
  BrowserLaunchInput,
  BrowserOptimizeSelectorInput,
  BrowserPressInput,
  BrowserScrollInput,
  BrowserSelectOptionInput,
  BrowserSetCookiesInput,
  BrowserSetGeolocationInput,
  BrowserSetStorageInput,
  BrowserSetViewportInput,
  BrowserScreenshotInput,
  BrowserUploadFileInput,
  BrowserWaitForResponseInput,
  BrowserWaitForResponseBodyInput,
  BrowserWaitForDownloadInput,
  CaptureOptions,
  EventStream,
  MonitorGetManifestInput,
  MonitorReadArtifactInput,
  MonitorStartInput,
  ReadEventsInput,
  Recorder,
  SearchBodiesInput,
  SearchEventsInput
} from "../types.js";

interface ActiveMonitor {
  trace: TraceSession;
  recorders: Recorder[];
  cookies?: CookieRecorder;
}

interface InspectionValue {
  value?: string;
  byteLength: number;
  sha256: string;
  ref?: BodyRef;
  outputPath?: string;
  outputDir?: string;
}

interface InspectionArtifact {
  outputPath: string;
  byteLength: number;
  sha256: string;
  outputDir?: string;
  ref?: BodyRef;
}

interface JsonInspectionValue {
  value?: unknown;
  byteLength: number;
  sha256: string;
  ref?: BodyRef;
  outputPath?: string;
  outputDir?: string;
}

interface SelectorTargetSummary {
  tagName: string;
  id?: string;
  type?: string;
  role?: string;
  name?: string;
  text?: string;
  placeholder?: string;
  ariaLabel?: string;
  visible: boolean;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

interface SelectorCandidateDraft {
  selector: string;
  source: string;
  reasons: string[];
  baseScore: number;
}

interface SelectorOptimizationScan {
  target: SelectorTargetSummary;
  candidates: SelectorCandidateDraft[];
}

interface VerifiedSelectorCandidate {
  selector: string;
  count: 1;
  score: number;
  source: string;
  reasons: string[];
}

interface RejectedSelectorCandidate {
  selector: string;
  source: string;
  reason: string;
  count?: number;
  error?: string;
}

interface DownloadRecord {
  downloadId: string;
  pageId?: string;
  url: string;
  suggestedFilename: string;
  outputPath: string;
  byteLength: number;
  sha256: string;
  createdAt: string;
}

const DEFAULT_OPTIMIZE_SELECTOR_LIMIT = 20;
const MAX_OPTIMIZE_SELECTOR_LIMIT = 100;

export class RawTraceRuntime {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private activeMonitor?: ActiveMonitor;
  private readonly sessions = new Map<string, TraceSession>();
  private ownedUserDataDir?: string;
  private browserMode?: "isolated" | "cdp";
  private inspectionArtifactSeq = 0;
  private readonly pageIds = new Map<Page, string>();
  private nextPageNumber = 0;
  private dialogHandler?: (dialog: Dialog) => void;
  private readonly downloads: DownloadRecord[] = [];
  private nextDownloadNumber = 0;

  async browserLaunch(input: BrowserLaunchInput = {}): Promise<Record<string, unknown>> {
    await this.browserClose().catch(() => undefined);
    if (input.storageStatePath) {
      assertCredentialAccessAcknowledged(input, "browser_launch");
      assertStorageStateOverwriteAcknowledgedForLaunch(input);
    }

    if (input.cdpUrl) {
      this.browser = await chromium.connectOverCDP(input.cdpUrl);
      this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      this.attachContext(this.context);
      if (input.storageStatePath) {
        await this.context.setStorageState(resolve(input.storageStatePath));
      }
      this.setActivePage(this.context.pages()[0] ?? (await this.context.newPage()));
      this.browserMode = "cdp";
      return this.browserInfo("cdp", input.cdpUrl);
    }

    const userDataDir = input.userDataDir ? resolve(input.userDataDir) : await mkdtemp(join(tmpdir(), "rawtrace-profile-"));
    this.ownedUserDataDir = input.userDataDir ? undefined : userDataDir;
    this.context = await chromium.launchPersistentContext(userDataDir, {
      headless: input.headless ?? false
    });
    this.browser = this.context.browser() ?? undefined;
    this.attachContext(this.context);
    if (input.storageStatePath) {
      await this.context.setStorageState(resolve(input.storageStatePath));
    }
    this.setActivePage(this.context.pages()[0] ?? (await this.context.newPage()));
    this.browserMode = "isolated";

    return this.browserInfo("isolated", userDataDir);
  }

  async browserNavigate(input: { url: string; waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" }): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const action = await this.startAction("navigate", { url: input.url, waitUntil: input.waitUntil ?? "domcontentloaded" });
    try {
      const response = await page.goto(input.url, { waitUntil: input.waitUntil ?? "domcontentloaded" });
      await this.finishAction(action, { status: response?.status(), urlAfter: page.url() });
      return {
        pageId: this.pageIdFor(page),
        url: page.url(),
        status: response?.status()
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserReload(input: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const action = await this.startAction("reload", { waitUntil: input.waitUntil ?? "domcontentloaded" });
    try {
      const response = await page.reload({
        waitUntil: input.waitUntil ?? "domcontentloaded",
        timeout: input.timeoutMs ?? 30_000
      });
      await this.finishAction(action, { status: response?.status(), urlAfter: page.url() });
      return {
        pageId: this.pageIdFor(page),
        url: page.url(),
        status: response?.status()
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserGoBack(input: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const action = await this.startAction("go_back", { waitUntil: input.waitUntil ?? "domcontentloaded" });
    try {
      const response = await page.goBack({
        waitUntil: input.waitUntil ?? "domcontentloaded",
        timeout: input.timeoutMs ?? 30_000
      });
      await this.finishAction(action, { status: response?.status(), urlAfter: page.url() });
      return {
        pageId: this.pageIdFor(page),
        url: page.url(),
        status: response?.status(),
        navigated: Boolean(response)
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserGoForward(input: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const action = await this.startAction("go_forward", { waitUntil: input.waitUntil ?? "domcontentloaded" });
    try {
      const response = await page.goForward({
        waitUntil: input.waitUntil ?? "domcontentloaded",
        timeout: input.timeoutMs ?? 30_000
      });
      await this.finishAction(action, { status: response?.status(), urlAfter: page.url() });
      return {
        pageId: this.pageIdFor(page),
        url: page.url(),
        status: response?.status(),
        navigated: Boolean(response)
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserListTabs(): Promise<Record<string, unknown>> {
    const context = this.requireContext();
    const action = await this.startAction("list_tabs", {});
    try {
      const pages = await Promise.all(context.pages().filter((page) => !page.isClosed()).map((page) => this.pageInfo(page)));
      await this.finishAction(action, { tabCount: pages.length, activePageId: this.page ? this.pageIdFor(this.page) : undefined });
      return {
        activePageId: this.page ? this.pageIdFor(this.page) : undefined,
        pages
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserNewTab(input: { url?: string; waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" } = {}): Promise<Record<string, unknown>> {
    const context = this.requireContext();
    const action = await this.startAction("new_tab", { url: input.url, waitUntil: input.waitUntil ?? "domcontentloaded" });
    try {
      const page = await context.newPage();
      this.setActivePage(page);
      let status: number | undefined;
      if (input.url) {
        const response = await page.goto(input.url, { waitUntil: input.waitUntil ?? "domcontentloaded" });
        status = response?.status();
      }
      const info = await this.pageInfo(page);
      await this.finishAction(action, { pageId: info.pageId, urlAfter: page.url(), status });
      return {
        ...info,
        status
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserSwitchTab(input: { pageId: string }): Promise<Record<string, unknown>> {
    const action = await this.startAction("switch_tab", { pageId: input.pageId });
    try {
      const page = this.findPage(input.pageId);
      this.setActivePage(page);
      await page.bringToFront().catch(() => undefined);
      const info = await this.pageInfo(page);
      await this.finishAction(action, { pageId: input.pageId, urlAfter: page.url() });
      return info;
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserCloseTab(input: { pageId?: string } = {}): Promise<Record<string, unknown>> {
    const target = input.pageId ? this.findPage(input.pageId) : this.requirePage();
    const pageId = this.pageIdFor(target);
    const action = await this.startAction("close_tab", { pageId });
    try {
      await target.close();
      this.pageIds.delete(target);
      if (this.page === target) {
        const nextPage = this.context?.pages().find((page) => !page.isClosed());
        this.page = nextPage;
        if (nextPage) {
          this.registerPage(nextPage);
        }
      }
      if (!this.page && this.context) {
        this.setActivePage(await this.context.newPage());
      }
      await this.finishAction(action, { closedPageId: pageId, activePageId: this.page ? this.pageIdFor(this.page) : undefined });
      return {
        closed: true,
        pageId,
        activePageId: this.page ? this.pageIdFor(this.page) : undefined
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserClose(): Promise<Record<string, unknown>> {
    if (this.activeMonitor) {
      await this.monitorStop();
    }

    if (this.browserMode === "isolated") {
      await this.context?.close().catch(() => undefined);
    } else if (this.browserMode === "cdp") {
      await this.browser?.close().catch(() => undefined);
    } else {
      await this.context?.close().catch(() => undefined);
      await this.browser?.close().catch(() => undefined);
    }

    const removedProfile = this.ownedUserDataDir;
    if (this.ownedUserDataDir) {
      await rm(this.ownedUserDataDir, { recursive: true, force: true }).catch(() => undefined);
    }

    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.ownedUserDataDir = undefined;
    this.browserMode = undefined;
    this.pageIds.clear();
    this.nextPageNumber = 0;
    this.dialogHandler = undefined;

    return {
      closed: true,
      removedProfile
    };
  }

  async monitorStart(input: MonitorStartInput): Promise<Record<string, unknown>> {
    if (input.acknowledgeRawCapture !== true) {
      throw new RawTraceError("RAW_CAPTURE_ACK_REQUIRED", "monitor_start requires acknowledgeRawCapture: true.", {
        warning: RAW_CAPTURE_WARNING
      });
    }
    if (this.activeMonitor) {
      throw new RawTraceError("MONITOR_ALREADY_RUNNING", "A monitor session is already running.");
    }

    const page = this.requirePage();
    const context = this.requireContext();
    const captureOptions = normalizeCaptureOptions(input);
    const trace = await TraceSession.create({
      captureOptions,
      baseOutputDir: resolve(captureOptions.outputDir ?? "rawtrace-traces"),
      pageUrlProvider: () => this.page?.url() ?? page.url()
    });
    this.sessions.set(trace.sessionId, trace);

    const recorders: Recorder[] = [];
    let cookies: CookieRecorder | undefined;

    if (captureOptions.captureDom) {
      recorders.push(new DomRecorder(page, trace));
    }
    if (captureOptions.captureNetwork) {
      recorders.push(new NetworkRecorder(page, trace, captureOptions.captureBodies, captureOptions.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES));
    }
    if (captureOptions.captureWebSockets) {
      recorders.push(new WebSocketRecorder(page, trace));
    }
    if (captureOptions.captureConsole) {
      recorders.push(new ConsoleRecorder(page, trace));
    }
    if (captureOptions.captureFrames) {
      recorders.push(new FrameRecorder(page, trace));
    }
    if (captureOptions.captureCookies) {
      cookies = new CookieRecorder(context, trace);
    }

    this.activeMonitor = { trace, recorders, cookies };
    for (const recorder of recorders) {
      await recorder.start();
    }
    if (captureOptions.captureDom) {
      await trace.writeSnapshot("initial-dom.html", await page.content());
    }
    await cookies?.snapshot("monitor_start");

    return {
      sessionId: trace.sessionId,
      outputDir: trace.outputDir,
      traceSchemaVersion: trace.manifest().traceSchemaVersion,
      warning: RAW_CAPTURE_WARNING
    };
  }

  async monitorStop(): Promise<Record<string, unknown>> {
    const activeMonitor = this.activeMonitor;
    if (!activeMonitor) {
      throw new RawTraceError("MONITOR_NOT_RUNNING", "No monitor session is running.");
    }

    const page = this.page;
    await activeMonitor.cookies?.diff("monitor_stop");
    if (page && activeMonitor.trace.captureOptions.captureDom) {
      await activeMonitor.trace.writeSnapshot("final-dom.html", await page.content().catch(() => ""));
    }
    for (const recorder of [...activeMonitor.recorders].reverse()) {
      await recorder.stop();
    }

    const manifest = await activeMonitor.trace.stop();
    this.activeMonitor = undefined;

    return {
      sessionId: activeMonitor.trace.sessionId,
      outputDir: activeMonitor.trace.outputDir,
      eventCounts: manifest.eventCounts
    };
  }

  async monitorListSessions(): Promise<Record<string, unknown>> {
    const sessions = [...this.sessions.values()].map((session) => session.manifest());
    const latest = sessions.at(-1);
    return {
      activeSessionId: this.activeMonitor?.trace.sessionId,
      latestSessionId: latest?.sessionId,
      count: sessions.length,
      sessions
    };
  }

  async monitorGetManifest(input: MonitorGetManifestInput = {}): Promise<Record<string, unknown>> {
    const session = this.resolveSession(input.sessionId);
    return session.manifest() as unknown as Record<string, unknown>;
  }

  async monitorGetSummary(input: { sessionId?: string } = {}): Promise<TraceSummary> {
    return summarizeTrace(this.resolveSession(input.sessionId));
  }

  async monitorReadEvents(input: ReadEventsInput): Promise<Record<string, unknown>> {
    const session = this.resolveSession(input.sessionId);
    const limit = input.limit ?? DEFAULT_READ_EVENTS_LIMIT;
    const result = await session.readEvents(input.stream, input.offset ?? 0, limit);
    return {
      sessionId: session.sessionId,
      stream: input.stream,
      offset: input.offset ?? 0,
      limit,
      total: result.total,
      events: result.events
    };
  }

  async monitorSearchEvents(input: SearchEventsInput): Promise<Record<string, unknown>> {
    const session = this.resolveSession(input.sessionId);
    const result = await session.searchEvents(input);
    return {
      sessionId: session.sessionId,
      stream: input.stream ?? "all",
      matches: result.matches,
      totalScanned: result.totalScanned,
      hasMore: result.hasMore
    };
  }

  async monitorSearchBodies(input: SearchBodiesInput): Promise<Record<string, unknown>> {
    assertRawCaptureAcknowledged(input, "monitor_search_bodies");
    const session = this.resolveSession(input.sessionId);
    const result = await session.searchBodies(input);
    return {
      sessionId: session.sessionId,
      matches: result.matches,
      totalScanned: result.totalScanned,
      hasMore: result.hasMore
    };
  }

  async monitorReadArtifact(input: MonitorReadArtifactInput): Promise<Record<string, unknown>> {
    assertRawCaptureAcknowledged(input, "monitor_read_artifact");
    const session = this.resolveSession(input.sessionId);
    const result = await session.readArtifact({
      path: input.path,
      ref: input.ref,
      maxBytes: input.maxBytes,
      asText: input.asText,
      parseJson: input.parseJson
    });
    return {
      sessionId: session.sessionId,
      ...result,
      warning: RAW_CAPTURE_WARNING
    };
  }

  async monitorExport(input: { sessionId?: string; format?: "zip"; outputPath?: string }): Promise<Record<string, unknown>> {
    const session = this.resolveSession(input.sessionId);
    const format = input.format ?? "zip";
    if (format !== "zip") {
      throw new RawTraceError("UNSUPPORTED_EXPORT_FORMAT", `Unsupported export format: ${format}`);
    }

    return {
      sessionId: session.sessionId,
      format,
      outputPath: await session.exportZip(input.outputPath)
    };
  }

  async browserClick(input: { selector: string; timeoutMs?: number }): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const action = await this.startAction("click", { selector: input.selector });
    try {
      await page.click(input.selector, { timeout: input.timeoutMs ?? 5000 });
      await this.finishAction(action, { urlAfter: page.url() });
      await this.activeMonitor?.cookies?.diff("after_click");
      return {
        clicked: true,
        selector: input.selector,
        url: page.url()
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserGetState(input: BrowserGetStateInput = {}): Promise<Record<string, unknown>> {
    assertRawCaptureAcknowledged(input, "browser_get_state");
    const page = this.requirePage();
    const action = await this.startAction("inspect.get_state", {});

    try {
      const [title, readyState, activeElement] = await Promise.all([
        page.title(),
        page.evaluate(() => document.readyState),
        page.evaluate(summarizeActiveElement)
      ]);
      const frames = page.frames().map((frame) => ({
        name: frame.name(),
        url: frame.url(),
        parentUrl: frame.parentFrame()?.url()
      }));
      const result = {
        url: page.url(),
        title,
        readyState,
        viewport: page.viewportSize(),
        frames,
        activeElement
      };

      await this.finishAction(action, {
        urlAfter: page.url(),
        title,
        readyState,
        frameCount: frames.length,
        activeElementTagName: activeElement?.tagName
      });
      return result;
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserGetDom(input: BrowserGetDomInput = {}): Promise<Record<string, unknown>> {
    assertRawCaptureAcknowledged(input, "browser_get_dom");
    const page = this.requirePage();
    const mode = input.mode ?? "both";
    const maxBytes = normalizeMaxBytes(input.maxBytes);
    const action = await this.startAction("inspect.get_dom", {
      selector: input.selector,
      mode,
      maxBytes
    });

    try {
      const title = await page.title();
      const target = input.selector ? page.locator(input.selector).first() : undefined;
      if (target && (await target.count()) === 0) {
        throw new RawTraceError("ELEMENT_NOT_FOUND", `No element matches selector: ${input.selector}`, {
          selector: input.selector
        });
      }

      const result: Record<string, unknown> = {
        url: page.url(),
        title,
        selector: input.selector,
        mode,
        maxBytes
      };

      let htmlResult: InspectionValue | undefined;
      let textResult: InspectionValue | undefined;

      if (mode === "html" || mode === "both") {
        const html = target ? await target.evaluate((element) => element.outerHTML) : await page.content();
        htmlResult = await this.materializeInspectionValue("dom_html", html, maxBytes, "html");
        result.html = htmlResult;
      }

      if (mode === "text" || mode === "both") {
        const text = target
          ? await target.evaluate((element) => (element instanceof HTMLElement ? element.innerText : element.textContent ?? ""))
          : await page.evaluate(() => document.body?.innerText ?? document.documentElement.innerText ?? "");
        textResult = await this.materializeInspectionValue("dom_text", text, maxBytes, "txt");
        result.text = textResult;
      }

      await this.finishAction(action, {
        urlAfter: page.url(),
        selector: input.selector,
        mode,
        htmlByteLength: htmlResult?.byteLength,
        htmlRef: htmlResult?.ref,
        textByteLength: textResult?.byteLength,
        textRef: textResult?.ref
      });
      return result;
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserGetElements(input: BrowserGetElementsInput = {}): Promise<Record<string, unknown>> {
    assertRawCaptureAcknowledged(input, "browser_get_elements");
    const page = this.requirePage();
    const limit = normalizeElementsLimit(input.limit);
    const action = await this.startAction("inspect.get_elements", {
      selector: input.selector,
      textContains: input.textContains,
      limit
    });

    try {
      const [title, scan] = await Promise.all([
        page.title(),
        page.evaluate(summarizeInteractiveElements, {
          selector: input.selector,
          textContains: input.textContains,
          limit
        })
      ]);
      const result = {
        url: page.url(),
        title,
        selector: input.selector,
        textContains: input.textContains,
        limit,
        ...scan
      };

      await this.finishAction(action, {
        urlAfter: page.url(),
        selector: input.selector,
        textContains: input.textContains,
        total: scan.total,
        returned: scan.elements.length
      });
      return result;
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserOptimizeSelector(input: BrowserOptimizeSelectorInput): Promise<Record<string, unknown>> {
    assertRawCaptureAcknowledged(input, "browser_optimize_selector");
    const page = this.requirePage();
    const candidateLimit = normalizeBoundedLimit(
      input.candidateLimit,
      DEFAULT_OPTIMIZE_SELECTOR_LIMIT,
      MAX_OPTIMIZE_SELECTOR_LIMIT,
      "browser_optimize_selector"
    );
    const targetIndex = Math.trunc(input.targetIndex ?? 0);
    const action = await this.startAction("inspect.optimize_selector", {
      selector: input.selector,
      targetIndex,
      textContains: input.textContains,
      role: input.role,
      name: input.name,
      candidateLimit,
      includeRejected: input.includeRejected ?? false
    });

    let targetHandle: ElementHandle | undefined;
    try {
      const locator = page.locator(input.selector);
      const inputCount = await locator.count();
      if (inputCount === 0) {
        throw new RawTraceError("ELEMENT_NOT_FOUND", `No element matches selector: ${input.selector}`, {
          selector: input.selector
        });
      }
      if (!Number.isFinite(targetIndex) || targetIndex < 0 || targetIndex >= inputCount) {
        throw new RawTraceError("TARGET_INDEX_OUT_OF_RANGE", `targetIndex ${targetIndex} is outside the ${inputCount} matched element(s).`, {
          selector: input.selector,
          targetIndex,
          inputCount
        });
      }

      targetHandle = (await locator.nth(targetIndex).elementHandle()) ?? undefined;
      if (!targetHandle) {
        throw new RawTraceError("ELEMENT_NOT_FOUND", `Unable to resolve target element for selector: ${input.selector}`, {
          selector: input.selector,
          targetIndex
        });
      }

      const [title, scan] = await Promise.all([
        page.title(),
        targetHandle.evaluate(buildSelectorOptimizationScan, {
          selector: input.selector,
          targetIndex,
          textContains: input.textContains,
          role: input.role,
          name: input.name
        })
      ]);
      const { accepted, rejected } = await verifySelectorCandidates(page, targetHandle, scan.candidates, scan.target, input);
      const candidates = accepted.slice(0, candidateLimit);
      const recommended = candidates[0] ?? null;
      const result: Record<string, unknown> = {
        url: page.url(),
        title,
        inputSelector: input.selector,
        inputCount,
        targetIndex,
        target: scan.target,
        recommended,
        candidates,
        candidateLimit
      };
      if (input.includeRejected) {
        result.rejected = rejected.slice(0, candidateLimit);
      }

      await this.finishAction(action, {
        urlAfter: page.url(),
        selector: input.selector,
        inputCount,
        targetIndex,
        accepted: accepted.length,
        rejected: rejected.length,
        recommended: recommended?.selector
      });
      return result;
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    } finally {
      await targetHandle?.dispose().catch(() => undefined);
    }
  }

  async browserScreenshot(input: BrowserScreenshotInput = {}): Promise<Record<string, unknown>> {
    assertRawCaptureAcknowledged(input, "browser_screenshot");
    const page = this.requirePage();
    const action = await this.startAction("inspect.screenshot", {
      selector: input.selector,
      fullPage: input.fullPage,
      outputPath: input.outputPath
    });

    try {
      let bytes: Buffer;
      if (input.selector) {
        const locator = page.locator(input.selector).first();
        if ((await locator.count()) === 0) {
          throw new RawTraceError("ELEMENT_NOT_FOUND", `No element matches selector: ${input.selector}`, {
            selector: input.selector
          });
        }
        bytes = await locator.screenshot();
      } else {
        bytes = await page.screenshot({ fullPage: input.fullPage ?? false });
      }

      const artifact = await this.writeInspectionArtifact("screenshot", bytes, "binary", "png", input.outputPath);
      const result = {
        url: page.url(),
        title: await page.title(),
        selector: input.selector,
        fullPage: input.fullPage ?? false,
        ...artifact
      };

      await this.finishAction(action, {
        urlAfter: page.url(),
        selector: input.selector,
        fullPage: input.fullPage ?? false,
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
        outputPath: artifact.outputPath,
        ref: artifact.ref
      });
      return result;
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserGetNetwork(input: BrowserGetNetworkInput = {}): Promise<Record<string, unknown>> {
    const session = this.resolveSession(input.sessionId);
    const limit = normalizeBoundedLimit(input.limit, DEFAULT_GET_NETWORK_LIMIT, MAX_GET_NETWORK_LIMIT, "browser_get_network");
    const expectedMethod = input.method?.toUpperCase();
    const sinceSeq = Math.max(0, Math.trunc(input.sinceSeq ?? 0));
    const action = await this.startAction("inspect.get_network", {
      sessionId: session.sessionId,
      urlContains: input.urlContains,
      method: expectedMethod,
      status: input.status,
      sinceSeq,
      limit
    });

    try {
      const events: Array<Record<string, unknown>> = [];
      let totalScanned = 0;
      let hasMore = false;
      for await (const event of session.iterateEvents("network")) {
        if (event.seq <= sinceSeq) {
          continue;
        }
        const url = stringValue(event.url) ?? stringValue(event.documentURL) ?? event.pageUrl;
        const method = stringValue(event.method)?.toUpperCase();
        const status = numberValue(event.status) ?? numberValue(event.statusCode);
        if (input.urlContains && !url.includes(input.urlContains)) {
          continue;
        }
        if (expectedMethod && method !== expectedMethod) {
          continue;
        }
        if (input.status !== undefined && status !== input.status) {
          continue;
        }

        totalScanned += 1;
        events.push(networkEventPreview(event));
        if (events.length > limit) {
          events.shift();
          hasMore = true;
        }
      }

      await this.finishAction(action, { returned: events.length, totalScanned, hasMore });
      return {
        sessionId: session.sessionId,
        events,
        totalScanned,
        hasMore
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserGetAccessibility(input: BrowserGetAccessibilityInput = {}): Promise<Record<string, unknown>> {
    assertRawCaptureAcknowledged(input, "browser_get_accessibility");
    const page = this.requirePage();
    const limit = normalizeBoundedLimit(input.limit, DEFAULT_ACCESSIBILITY_LIMIT, MAX_ACCESSIBILITY_LIMIT, "browser_get_accessibility");
    const action = await this.startAction("inspect.get_accessibility", {
      selector: input.selector,
      textContains: input.textContains,
      limit
    });

    try {
      const [title, scan] = await Promise.all([
        page.title(),
        page.evaluate(summarizeAccessibilityElements, {
          selector: input.selector,
          textContains: input.textContains,
          limit
        })
      ]);
      const result = {
        url: page.url(),
        title,
        selector: input.selector,
        textContains: input.textContains,
        limit,
        ...scan
      };
      await this.finishAction(action, { returned: scan.elements.length, total: scan.total, urlAfter: page.url() });
      return result;
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserEval(input: BrowserEvalInput): Promise<Record<string, unknown>> {
    assertDangerousEvalAcknowledged(input, "browser_eval");
    const page = this.requirePage();
    const maxBytes = normalizeMaxBytes(input.maxBytes);
    const expression = await this.materializeInspectionValue("eval_expression", input.expression, maxBytes, "js");
    const action = await this.startAction("eval", {
      expressionLength: input.expression.length,
      expression: expression.value,
      expressionRef: expression.ref,
      frameUrlContains: input.frameUrlContains,
      frameName: input.frameName,
      maxBytes
    });

    try {
      const frame = this.resolveFrame(page, input);
      const result = await withTimeout(
        frame.evaluate(input.expression, input.arg),
        input.timeoutMs ?? 5000,
        "browser_eval timed out.",
        () => this.recoverPageAfterEvalTimeout(page)
      );
      const materialized = await this.materializeJsonValue("eval_result", result, maxBytes);
      await this.finishAction(action, {
        urlAfter: page.url(),
        frameUrl: frame.url(),
        resultByteLength: materialized.byteLength,
        resultRef: materialized.ref
      });
      await this.activeMonitor?.cookies?.diff("after_eval");
      return {
        pageId: this.pageIdFor(page),
        url: page.url(),
        frameUrl: frame.url(),
        result: materialized,
        warning: DANGEROUS_EVAL_WARNING
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserGetCookies(input: BrowserGetCookiesInput = {}): Promise<Record<string, unknown>> {
    assertCredentialAccessAcknowledged(input, "browser_get_cookies");
    const context = this.requireContext();
    const action = await this.startAction("credentials.get_cookies", { urlCount: input.urls?.length ?? 0 });
    try {
      const cookies = await context.cookies(input.urls);
      await this.finishAction(action, { cookieCount: cookies.length });
      return {
        cookies,
        count: cookies.length,
        warning: CREDENTIAL_ACCESS_WARNING
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserSetCookies(input: BrowserSetCookiesInput): Promise<Record<string, unknown>> {
    assertCredentialAccessAcknowledged(input, "browser_set_cookies");
    const context = this.requireContext();
    const action = await this.startAction("credentials.set_cookies", { cookieCount: input.cookies.length });
    try {
      await context.addCookies(input.cookies as unknown as Cookie[]);
      await this.activeMonitor?.cookies?.diff("after_set_cookies");
      await this.finishAction(action, { cookieCount: input.cookies.length });
      return {
        set: true,
        count: input.cookies.length,
        warning: CREDENTIAL_ACCESS_WARNING
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserClearCookies(input: BrowserClearCookiesInput = {}): Promise<Record<string, unknown>> {
    assertCredentialAccessAcknowledged(input, "browser_clear_cookies");
    const context = this.requireContext();
    const action = await this.startAction("credentials.clear_cookies", {
      name: input.name,
      domain: input.domain,
      path: input.path
    });
    try {
      await context.clearCookies({
        name: input.name,
        domain: input.domain,
        path: input.path
      });
      await this.activeMonitor?.cookies?.diff("after_clear_cookies");
      await this.finishAction(action, { cleared: true });
      return {
        cleared: true,
        warning: CREDENTIAL_ACCESS_WARNING
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserGetStorage(input: BrowserGetStorageInput = {}): Promise<Record<string, unknown>> {
    assertCredentialAccessAcknowledged(input, "browser_get_storage");
    const page = this.requirePage();
    const maxBytes = normalizeMaxBytes(input.maxBytes);
    const action = await this.startAction("credentials.get_storage", {
      origin: input.origin,
      includeSessionStorage: input.includeSessionStorage ?? true,
      maxBytes
    });
    try {
      const storage = await page.evaluate(readPageStorage, {
        origin: input.origin,
        includeSessionStorage: input.includeSessionStorage ?? true
      });
      const materialized = await this.materializeJsonValue("storage", storage, maxBytes);
      await this.finishAction(action, {
        origin: storage.origin,
        localStorageCount: storage.localStorage.length,
        sessionStorageCount: storage.sessionStorage?.length,
        storageRef: materialized.ref
      });
      return {
        url: page.url(),
        origin: storage.origin,
        storage: materialized,
        warning: CREDENTIAL_ACCESS_WARNING
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserSetStorage(input: BrowserSetStorageInput): Promise<Record<string, unknown>> {
    assertCredentialAccessAcknowledged(input, "browser_set_storage");
    const page = this.requirePage();
    const action = await this.startAction("credentials.set_storage", {
      origin: input.origin,
      localStorageKeys: Object.keys(input.localStorage ?? {}),
      sessionStorageKeys: Object.keys(input.sessionStorage ?? {})
    });
    try {
      const result = await page.evaluate(writePageStorage, {
        origin: input.origin,
        localStorage: input.localStorage ?? {},
        sessionStorage: input.sessionStorage ?? {}
      });
      await this.finishAction(action, {
        origin: result.origin,
        localStorageChanged: result.localStorageChanged,
        sessionStorageChanged: result.sessionStorageChanged
      });
      return {
        ...result,
        warning: CREDENTIAL_ACCESS_WARNING
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserExportStorageState(input: BrowserExportStorageStateInput = {}): Promise<Record<string, unknown>> {
    assertCredentialAccessAcknowledged(input, "browser_export_storage_state");
    const context = this.requireContext();
    const maxBytes = normalizeMaxBytes(input.maxBytes);
    const action = await this.startAction("credentials.export_storage_state", {
      outputPath: input.outputPath,
      indexedDB: input.indexedDB ?? false,
      maxBytes
    });
    try {
      const state = await context.storageState({ indexedDB: input.indexedDB ?? false });
      const materialized = input.outputPath
        ? await this.writeJsonArtifact("storage_state", state, input.outputPath)
        : await this.materializeJsonValue("storage_state", state, maxBytes);
      await this.finishAction(action, {
        cookieCount: state.cookies.length,
        originCount: state.origins.length,
        outputPath: materialized.outputPath,
        stateRef: materialized.ref
      });
      return {
        cookies: state.cookies.length,
        origins: state.origins.length,
        state: materialized,
        warning: CREDENTIAL_ACCESS_WARNING
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserImportStorageState(input: BrowserImportStorageStateInput): Promise<Record<string, unknown>> {
    assertCredentialAccessAcknowledged(input, "browser_import_storage_state");
    const context = this.requireContext();
    if (this.storageStateOverwriteRequiresAcknowledgement()) {
      assertStorageStateOverwriteAcknowledged(input, "browser_import_storage_state");
    }
    const absolutePath = resolve(input.path);
    const action = await this.startAction("credentials.import_storage_state", { path: absolutePath });
    try {
      const state = JSON.parse(await readFile(absolutePath, "utf8")) as Awaited<ReturnType<BrowserContext["storageState"]>>;
      await context.setStorageState(state);
      await this.activeMonitor?.cookies?.diff("after_import_storage_state");
      await this.finishAction(action, {
        cookieCount: state.cookies.length,
        originCount: state.origins.length
      });
      return {
        imported: true,
        path: absolutePath,
        cookies: state.cookies.length,
        origins: state.origins.length,
        warning: CREDENTIAL_ACCESS_WARNING
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserType(input: { selector: string; text: string; delayMs?: number; timeoutMs?: number }): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const action = await this.startAction("type", {
      selector: input.selector,
      textLength: input.text.length
    });
    try {
      await page.fill(input.selector, "");
      await page.type(input.selector, input.text, {
        delay: input.delayMs ?? 0,
        timeout: input.timeoutMs ?? 5000
      });
      await this.finishAction(action, { urlAfter: page.url() });
      await this.activeMonitor?.cookies?.diff("after_type");
      return {
        typed: true,
        selector: input.selector,
        length: input.text.length,
        url: page.url()
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserPress(input: BrowserPressInput): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const action = await this.startAction("press", {
      selector: input.selector,
      key: input.key
    });
    try {
      if (input.selector) {
        await page.locator(input.selector).first().focus({ timeout: input.timeoutMs ?? 5000 });
      }
      await page.keyboard.press(input.key, { delay: input.delayMs ?? 0 });
      await this.finishAction(action, { urlAfter: page.url() });
      await this.activeMonitor?.cookies?.diff("after_press");
      return {
        pressed: true,
        key: input.key,
        selector: input.selector,
        url: page.url()
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserHover(input: BrowserHoverInput): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const action = await this.startAction("hover", { selector: input.selector });
    try {
      await page.locator(input.selector).first().hover({ timeout: input.timeoutMs ?? 5000 });
      await this.finishAction(action, { urlAfter: page.url() });
      return {
        hovered: true,
        selector: input.selector,
        url: page.url()
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserScroll(input: BrowserScrollInput = {}): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const deltaX = input.deltaX ?? 0;
    const deltaY = input.deltaY ?? 600;
    const action = await this.startAction("scroll", {
      selector: input.selector,
      deltaX,
      deltaY
    });
    try {
      if (input.selector) {
        const locator = page.locator(input.selector).first();
        await locator.scrollIntoViewIfNeeded({ timeout: input.timeoutMs ?? 5000 });
        await locator.hover({ timeout: input.timeoutMs ?? 5000 });
      }
      await page.mouse.wheel(deltaX, deltaY);
      await this.finishAction(action, { urlAfter: page.url() });
      return {
        scrolled: true,
        selector: input.selector,
        deltaX,
        deltaY,
        url: page.url()
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserSelectOption(input: BrowserSelectOptionInput): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const action = await this.startAction("select_option", {
      selector: input.selector,
      values: input.values
    });
    try {
      const values = normalizeSelectOptionValues(input.values);
      const selected = await page.locator(input.selector).first().selectOption(values, { timeout: input.timeoutMs ?? 5000 });
      await this.finishAction(action, { urlAfter: page.url(), selected });
      await this.activeMonitor?.cookies?.diff("after_select_option");
      return {
        selected,
        selector: input.selector,
        url: page.url()
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserCheck(input: BrowserCheckInput): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const checked = input.checked ?? true;
    const action = await this.startAction("check", {
      selector: input.selector,
      checked
    });
    try {
      const locator = page.locator(input.selector).first();
      if (checked) {
        await locator.check({ timeout: input.timeoutMs ?? 5000 });
      } else {
        await locator.uncheck({ timeout: input.timeoutMs ?? 5000 });
      }
      await this.finishAction(action, { urlAfter: page.url(), checked });
      await this.activeMonitor?.cookies?.diff("after_check");
      return {
        checked,
        selector: input.selector,
        url: page.url()
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserWaitForResponse(input: BrowserWaitForResponseInput): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const timeoutMs = input.timeoutMs ?? 5000;
    const expectedMethod = input.method?.toUpperCase();
    const urlRegex = input.urlRegex ? compileRegex(input.urlRegex, "browser_wait_for_response") : undefined;
    if (!input.urlContains && !urlRegex && !expectedMethod && input.status === undefined) {
      throw new RawTraceError("WAIT_RESPONSE_FILTER_REQUIRED", "browser_wait_for_response requires at least one filter.");
    }
    const action = await this.startAction("wait_for_response", {
      urlContains: input.urlContains,
      urlRegex: input.urlRegex,
      method: expectedMethod,
      status: input.status
    });
    try {
      const response = await page.waitForResponse(
        (candidate) => {
          const request = candidate.request();
          const url = candidate.url();
          if (input.urlContains && !url.includes(input.urlContains)) {
            return false;
          }
          if (urlRegex && !urlRegex.test(url)) {
            return false;
          }
          if (expectedMethod && request.method().toUpperCase() !== expectedMethod) {
            return false;
          }
          if (input.status !== undefined && candidate.status() !== input.status) {
            return false;
          }
          return true;
        },
        { timeout: timeoutMs }
      );
      const result = {
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        method: response.request().method(),
        pageUrl: page.url()
      };
      await this.finishAction(action, result);
      return result;
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserWaitForResponseBody(input: BrowserWaitForResponseBodyInput): Promise<Record<string, unknown>> {
    assertRawCaptureAcknowledged(input, "browser_wait_for_response_body");
    const page = this.requirePage();
    const timeoutMs = input.timeoutMs ?? 5000;
    const expectedMethod = input.method?.toUpperCase();
    const urlRegex = input.urlRegex ? compileRegex(input.urlRegex, "browser_wait_for_response_body") : undefined;
    const maxBytes = normalizeMaxBytes(input.maxBytes);
    if (!input.urlContains && !urlRegex && !expectedMethod && input.status === undefined) {
      throw new RawTraceError("WAIT_RESPONSE_FILTER_REQUIRED", "browser_wait_for_response_body requires at least one filter.");
    }
    const action = await this.startAction("wait_for_response_body", {
      urlContains: input.urlContains,
      urlRegex: input.urlRegex,
      method: expectedMethod,
      status: input.status,
      maxBytes,
      parseJson: input.parseJson ?? false
    });
    try {
      const response = await page.waitForResponse(
        (candidate) => {
          const request = candidate.request();
          const url = candidate.url();
          if (input.urlContains && !url.includes(input.urlContains)) {
            return false;
          }
          if (urlRegex && !urlRegex.test(url)) {
            return false;
          }
          if (expectedMethod && request.method().toUpperCase() !== expectedMethod) {
            return false;
          }
          if (input.status !== undefined && candidate.status() !== input.status) {
            return false;
          }
          return true;
        },
        { timeout: timeoutMs }
      );
      const headers = response.headers();
      const contentLength = parseContentLength(headers["content-length"]);
      const body =
        contentLength !== undefined && contentLength > maxBytes
          ? skippedResponseBody(contentLength, maxBytes, headers["content-type"], "contentLength_exceeds_maxBytes")
          : await this.materializeResponseBody("response_body", await response.body(), maxBytes, input.parseJson ?? false, headers["content-type"]);
      const result = {
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        method: response.request().method(),
        pageUrl: page.url(),
        headers,
        body
      };
      await this.finishAction(action, {
        url: response.url(),
        status: response.status(),
        method: response.request().method(),
        bodyByteLength: body.byteLength,
        bodyRef: body.ref
      });
      return result;
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserUploadFile(input: BrowserUploadFileInput): Promise<Record<string, unknown>> {
    assertFileAccessAcknowledged(input, "browser_upload_file");
    const page = this.requirePage();
    const absolutePaths = input.paths.map((filePath) => resolve(filePath));
    const action = await this.startAction("upload_file", {
      selector: input.selector,
      fileCount: absolutePaths.length,
      fileNames: absolutePaths.map((filePath) => basename(filePath))
    });
    try {
      await page.locator(input.selector).first().setInputFiles(absolutePaths, { timeout: input.timeoutMs ?? 5000 });
      await this.finishAction(action, { urlAfter: page.url(), fileCount: absolutePaths.length });
      await this.activeMonitor?.cookies?.diff("after_upload_file");
      return {
        uploaded: true,
        selector: input.selector,
        fileCount: absolutePaths.length,
        paths: absolutePaths,
        warning: FILE_ACCESS_WARNING
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserWaitForDownload(input: BrowserWaitForDownloadInput = {}): Promise<Record<string, unknown>> {
    assertRawCaptureAcknowledged(input, "browser_wait_for_download");
    const page = this.requirePage();
    const downloadId = `download_${String(++this.nextDownloadNumber).padStart(6, "0")}`;
    const action = await this.startAction("wait_for_download", {
      triggerSelector: input.triggerSelector,
      outputDir: input.outputDir,
      suggestedFilename: input.suggestedFilename
    });
    try {
      const downloadPromise = page.waitForEvent("download", { timeout: input.timeoutMs ?? 30_000 });
      if (input.triggerSelector) {
        await page.locator(input.triggerSelector).first().click({ timeout: input.timeoutMs ?? 5000 });
      }
      const download = await downloadPromise;
      const outputDir = resolve(input.outputDir ?? join("rawtrace-traces", "downloads", makeInspectionId()));
      await mkdir(outputDir, { recursive: true });
      const safeFilename = sanitizeDownloadFilename(input.suggestedFilename ?? download.suggestedFilename() ?? "download.bin");
      const outputPath = join(outputDir, `${downloadId}_${safeFilename}`);
      await download.saveAs(outputPath);
      const bytes = await readFile(outputPath);
      const record: DownloadRecord = {
        downloadId,
        pageId: this.pageIdFor(page),
        url: download.url(),
        suggestedFilename: download.suggestedFilename(),
        outputPath,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
        createdAt: new Date().toISOString()
      };
      this.downloads.push(record);
      await this.finishAction(action, {
        downloadId,
        url: record.url,
        outputPath,
        byteLength: record.byteLength,
        sha256: record.sha256
      });
      return {
        ...record,
        warning: RAW_CAPTURE_WARNING
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserGetDownloads(input: BrowserGetDownloadsInput = {}): Promise<Record<string, unknown>> {
    const limit = normalizeBoundedLimit(input.limit, DEFAULT_GET_DOWNLOADS_LIMIT, MAX_GET_DOWNLOADS_LIMIT, "browser_get_downloads");
    const downloads = this.downloads.slice(-limit);
    return {
      count: this.downloads.length,
      limit,
      downloads
    };
  }

  async browserSetViewport(input: BrowserSetViewportInput): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const action = await this.startAction("set_viewport", { width: input.width, height: input.height });
    try {
      await page.setViewportSize({ width: input.width, height: input.height });
      const viewport = page.viewportSize();
      await this.finishAction(action, { viewport, urlAfter: page.url() });
      return {
        pageId: this.pageIdFor(page),
        viewport
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserGrantPermissions(input: BrowserGrantPermissionsInput): Promise<Record<string, unknown>> {
    assertPermissionChangeAcknowledged(input, "browser_grant_permissions");
    const context = this.requireContext();
    const action = await this.startAction("grant_permissions", {
      permissions: input.permissions,
      origin: input.origin
    });
    try {
      await context.grantPermissions(input.permissions as Parameters<BrowserContext["grantPermissions"]>[0], input.origin ? { origin: input.origin } : undefined);
      await this.finishAction(action, { granted: true, permissionCount: input.permissions.length });
      return {
        granted: true,
        permissions: input.permissions,
        origin: input.origin,
        warning: PERMISSION_CHANGE_WARNING
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserSetGeolocation(input: BrowserSetGeolocationInput): Promise<Record<string, unknown>> {
    assertLocationAccessAcknowledged(input, "browser_set_geolocation");
    const context = this.requireContext();
    const action = await this.startAction("set_geolocation", {
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy: input.accuracy
    });
    try {
      const geolocation = {
        latitude: input.latitude,
        longitude: input.longitude,
        accuracy: input.accuracy
      };
      await context.setGeolocation(geolocation);
      await this.finishAction(action, { geolocation });
      return {
        geolocation,
        warning: LOCATION_ACCESS_WARNING
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserGetForms(input: BrowserGetFormsInput = {}): Promise<Record<string, unknown>> {
    assertRawCaptureAcknowledged(input, "browser_get_forms");
    const page = this.requirePage();
    const limit = normalizeBoundedLimit(input.limit, DEFAULT_GET_FORMS_LIMIT, MAX_GET_FORMS_LIMIT, "browser_get_forms");
    const maxBytes = normalizeMaxBytes(input.maxBytes);
    const action = await this.startAction("inspect.get_forms", {
      selector: input.selector,
      textContains: input.textContains,
      limit,
      maxBytes
    });
    try {
      const [title, scan] = await Promise.all([
        page.title(),
        page.evaluate(summarizeForms, {
          selector: input.selector,
          textContains: input.textContains,
          limit
        })
      ]);
      const materialized = await this.materializeJsonValue("forms", scan, maxBytes);
      const result = {
        url: page.url(),
        title,
        selector: input.selector,
        textContains: input.textContains,
        limit,
        maxBytes,
        totalForms: scan.totalForms,
        totalControls: scan.totalControls,
        ...(materialized.value ? (materialized.value as Record<string, unknown>) : { formsRef: materialized.ref, outputPath: materialized.outputPath, outputDir: materialized.outputDir }),
        byteLength: materialized.byteLength,
        sha256: materialized.sha256,
        warning: RAW_CAPTURE_WARNING
      };
      await this.finishAction(action, {
        urlAfter: page.url(),
        totalForms: scan.totalForms,
        totalControls: scan.totalControls,
        returnedForms: scan.forms.length,
        byteLength: materialized.byteLength,
        formsRef: materialized.ref
      });
      return result;
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserFillForm(input: BrowserFillFormInput): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const timeoutMs = input.timeoutMs ?? 5000;
    const action = await this.startAction("fill_form", {
      fieldCount: input.fields.length,
      submitSelector: input.submitSelector,
      fieldTargets: input.fields.map((field) => ({
        selector: field.selector,
        name: field.name,
        label: field.label,
        placeholder: field.placeholder,
        valueLength: valueLength(field.value),
        checked: field.checked
      }))
    });
    try {
      const filled: Array<Record<string, unknown>> = [];
      for (let index = 0; index < input.fields.length; index += 1) {
        const field = input.fields[index]!;
        const locator = this.formFieldLocator(page, field);
        const count = await locator.count();
        if (count === 0) {
          throw new RawTraceError("FORM_FIELD_NOT_FOUND", "No form control matches the requested field.", {
            index,
            selector: field.selector,
            name: field.name,
            label: field.label,
            placeholder: field.placeholder
          });
        }
        const target = locator.first();
        const control = await target.evaluate(summarizeFormControlForFill);
        const result = await fillFormControl(target, field, timeoutMs, control);
        filled.push({
          index,
          selector: field.selector,
          name: field.name,
          label: field.label,
          placeholder: field.placeholder,
          control,
          ...result
        });
      }

      let submitted = false;
      if (input.submitSelector) {
        await page.locator(input.submitSelector).first().click({ timeout: timeoutMs });
        submitted = true;
      }

      await this.finishAction(action, {
        urlAfter: page.url(),
        filledCount: filled.length,
        submitted
      });
      await this.activeMonitor?.cookies?.diff("after_fill_form");
      return {
        filledCount: filled.length,
        submitted,
        submitSelector: input.submitSelector,
        fields: filled,
        url: page.url()
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserHandleDialog(input: BrowserHandleDialogInput): Promise<Record<string, unknown>> {
    const context = this.requireContext();
    const once = input.once ?? true;
    const action = await this.startAction("handle_dialog", {
      dialogAction: input.action,
      once,
      hasPromptText: input.promptText !== undefined
    });
    try {
      if (this.dialogHandler) {
        context.off("dialog", this.dialogHandler);
      }

      const handler = (dialog: Dialog): void => {
        void (async () => {
          try {
            await this.activeMonitor?.trace.append("actions", "dialog.detected", {
              dialogType: dialog.type(),
              message: dialog.message(),
              defaultValue: dialog.defaultValue(),
              action: input.action
            });
            if (input.action === "accept") {
              await dialog.accept(input.promptText);
            } else {
              await dialog.dismiss();
            }
            await this.activeMonitor?.trace.append("actions", "dialog.handled", {
              dialogType: dialog.type(),
              action: input.action,
              once
            });
          } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            await this.activeMonitor?.trace.append("actions", "dialog.error", {
              dialogType: dialog.type(),
              action: input.action,
              errorName: normalizedError.name,
              errorMessage: normalizedError.message,
              errorStack: normalizedError.stack
            }).catch(() => undefined);
          } finally {
            if (once) {
              context.off("dialog", handler);
              if (this.dialogHandler === handler) {
                this.dialogHandler = undefined;
              }
            }
          }
        })();
      };

      this.dialogHandler = handler;
      context.on("dialog", handler);
      await this.finishAction(action, { registered: true, once });
      return {
        registered: true,
        action: input.action,
        once
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  async browserWait(input: {
    mode: "quiet" | "selector" | "url" | "timeout";
    quietMs?: number;
    timeoutMs?: number;
    selector?: string;
    pattern?: string;
    delayMs?: number;
  }): Promise<Record<string, unknown>> {
    const page = this.requirePage();
    const timeoutMs = input.timeoutMs ?? 5000;
    const action = await this.startAction("wait", { mode: input.mode });

    try {
      if (input.mode === "timeout") {
        await delay(input.delayMs ?? timeoutMs);
      } else if (input.mode === "selector") {
        if (!input.selector) {
          throw new RawTraceError("WAIT_SELECTOR_REQUIRED", "browser_wait mode selector requires selector.");
        }
        await page.waitForSelector(input.selector, { timeout: timeoutMs });
      } else if (input.mode === "url") {
        if (!input.pattern) {
          throw new RawTraceError("WAIT_URL_PATTERN_REQUIRED", "browser_wait mode url requires pattern.");
        }
        await page.waitForURL((url) => url.toString().includes(input.pattern ?? ""), { timeout: timeoutMs });
      } else {
        await this.waitForQuiet(input.quietMs ?? 500, timeoutMs);
      }

      await this.finishAction(action, { urlAfter: page.url() });
      await this.activeMonitor?.cookies?.diff("after_wait");
      return {
        waited: true,
        mode: input.mode,
        url: page.url()
      };
    } catch (error) {
      await this.failAction(action, error);
      throw error;
    }
  }

  private attachContext(context: BrowserContext): void {
    for (const page of context.pages()) {
      this.registerPage(page);
    }
    context.on("page", (page) => {
      this.setActivePage(page);
    });
  }

  private registerPage(page: Page): string {
    const existing = this.pageIds.get(page);
    if (existing) {
      return existing;
    }
    const pageId = `page_${++this.nextPageNumber}`;
    this.pageIds.set(page, pageId);
    page.once("close", () => {
      this.pageIds.delete(page);
      if (this.page === page) {
        this.page = this.context?.pages().find((candidate) => !candidate.isClosed());
      }
    });
    return pageId;
  }

  private setActivePage(page: Page): void {
    this.registerPage(page);
    this.page = page;
  }

  private pageIdFor(page: Page): string {
    return this.registerPage(page);
  }

  private findPage(pageId: string): Page {
    const page = [...this.pageIds.entries()].find(([candidate, candidateId]) => candidateId === pageId && !candidate.isClosed())?.[0];
    if (!page) {
      throw new RawTraceError("PAGE_NOT_FOUND", `Unknown or closed pageId: ${pageId}`, { pageId });
    }
    return page;
  }

  private async pageInfo(page: Page): Promise<Record<string, unknown>> {
    return {
      pageId: this.pageIdFor(page),
      active: this.page === page,
      url: page.url(),
      title: await page.title().catch(() => ""),
      closed: page.isClosed()
    };
  }

  private storageStateOverwriteRequiresAcknowledgement(): boolean {
    return this.browserMode === "cdp" || this.ownedUserDataDir === undefined;
  }

  private async recoverPageAfterEvalTimeout(page: Page): Promise<Record<string, unknown>> {
    const timedOutPageId = this.pageIdFor(page);
    const context = this.context;
    await Promise.race([page.close({ runBeforeUnload: false }).catch(() => undefined), delay(1000)]);
    this.pageIds.delete(page);

    let activePage = context?.pages().find((candidate) => !candidate.isClosed());
    if (!activePage && context) {
      activePage = await context.newPage();
    }
    if (activePage) {
      this.setActivePage(activePage);
    } else if (this.page === page) {
      this.page = undefined;
    }

    return {
      recovery: "closed_page",
      timedOutPageId,
      activePageId: activePage ? this.pageIdFor(activePage) : undefined
    };
  }

  private resolveFrame(page: Page, input: { frameName?: string; frameUrlContains?: string }): Frame {
    const frames = page.frames();
    const frame = frames.find((candidate) => {
      if (input.frameName && candidate.name() !== input.frameName) {
        return false;
      }
      if (input.frameUrlContains && !candidate.url().includes(input.frameUrlContains)) {
        return false;
      }
      return true;
    });
    if (!frame) {
      throw new RawTraceError("FRAME_NOT_FOUND", "No frame matches the requested frame filters.", {
        frameName: input.frameName,
        frameUrlContains: input.frameUrlContains,
        frames: frames.map((candidate) => ({ name: candidate.name(), url: candidate.url() }))
      });
    }
    return frame;
  }

  private formFieldLocator(page: Page, field: BrowserFillFormInput["fields"][number]): Locator {
    if (field.selector) {
      return page.locator(field.selector);
    }
    if (field.label) {
      return page.getByLabel(field.label);
    }
    if (field.placeholder) {
      return page.getByPlaceholder(field.placeholder);
    }
    if (field.name) {
      return page.locator(`[name="${quoteCssAttribute(field.name)}"]`);
    }
    throw new RawTraceError("FORM_FIELD_TARGET_REQUIRED", "Form field requires selector, name, label, or placeholder.");
  }

  private async materializeResponseBody(
    kind: string,
    bytes: Buffer,
    maxBytes: number,
    parseJson: boolean,
    contentType?: string
  ): Promise<Record<string, unknown> & { byteLength: number; ref?: BodyRef }> {
    const digest = sha256(bytes);
    const base = {
      byteLength: bytes.byteLength,
      sha256: digest,
      contentType,
      maxBytes,
      truncated: bytes.byteLength > maxBytes
    };

    if (bytes.byteLength > maxBytes) {
      const artifact = await this.writeInspectionArtifact(kind, bytes, "binary", extensionForContentType(contentType));
      return {
        ...base,
        ref: artifact.ref,
        outputPath: artifact.outputPath,
        outputDir: artifact.outputDir,
        contentSkippedReason: "byteLength_exceeds_maxBytes"
      };
    }

    if (parseJson) {
      try {
        return {
          ...base,
          json: JSON.parse(bytes.toString("utf8")) as unknown,
          contentEncoding: "json"
        };
      } catch (error) {
        throw new RawTraceError("RESPONSE_BODY_PARSE_FAILED", "Unable to parse response body as JSON.", {
          cause: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (looksTextContent(contentType)) {
      return {
        ...base,
        text: bytes.toString("utf8"),
        contentEncoding: "utf8"
      };
    }

    return {
      ...base,
      base64: bytes.toString("base64"),
      contentEncoding: "base64"
    };
  }

  private async materializeJsonValue(kind: string, value: unknown, maxBytes: number): Promise<JsonInspectionValue> {
    const serialized = serializeJsonValue(value);
    const bytes = Buffer.from(serialized, "utf8");
    if (bytes.byteLength <= maxBytes) {
      return {
        value,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes)
      };
    }

    const artifact = await this.writeInspectionArtifact(kind, serialized, "utf8", "json");
    return {
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
      ref: artifact.ref,
      outputPath: artifact.outputPath,
      outputDir: artifact.outputDir
    };
  }

  private async writeJsonArtifact(kind: string, value: unknown, outputPath: string): Promise<JsonInspectionValue> {
    const serialized = serializeJsonValue(value);
    const artifact = await this.writeInspectionArtifact(kind, serialized, "utf8", "json", outputPath);
    return {
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
      ref: artifact.ref,
      outputPath: artifact.outputPath,
      outputDir: artifact.outputDir
    };
  }

  private async waitForQuiet(quietMs: number, timeoutMs: number): Promise<void> {
    const monitor = this.activeMonitor;
    if (!monitor) {
      await delay(quietMs);
      return;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (Date.now() - monitor.trace.lastEventWallTimeMs >= quietMs) {
        return;
      }
      await delay(Math.min(50, quietMs));
    }

    throw new RawTraceError("WAIT_TIMEOUT", `No quiet period of ${quietMs}ms observed within ${timeoutMs}ms.`);
  }

  private async startAction(type: string, payload: Record<string, unknown>): Promise<{ type: string; tStartWall: number; urlBefore: string }> {
    const urlBefore = this.page?.url() ?? "";
    await this.activeMonitor?.trace.append("actions", `${type}.start`, {
      ...payload,
      pageId: this.page ? this.pageIdFor(this.page) : undefined,
      urlBefore
    });
    return {
      type,
      tStartWall: Date.now(),
      urlBefore
    };
  }

  private async finishAction(action: { type: string; tStartWall: number; urlBefore: string }, payload: Record<string, unknown>): Promise<void> {
    await this.activeMonitor?.trace.append("actions", `${action.type}.end`, {
      ...payload,
      urlBefore: action.urlBefore,
      pageId: this.page ? this.pageIdFor(this.page) : undefined,
      durationMs: Date.now() - action.tStartWall
    });
  }

  private async failAction(action: { type: string; tStartWall: number; urlBefore: string }, error: unknown): Promise<void> {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    await this.activeMonitor?.trace.append("actions", `${action.type}.error`, {
      urlBefore: action.urlBefore,
      urlAfter: this.page?.url() ?? "",
      pageId: this.page ? this.pageIdFor(this.page) : undefined,
      durationMs: Date.now() - action.tStartWall,
      errorName: normalizedError.name,
      errorMessage: normalizedError.message,
      errorStack: normalizedError.stack
    });
  }

  private async materializeInspectionValue(kind: string, value: string, maxBytes: number, extension: string): Promise<InspectionValue> {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.byteLength <= maxBytes) {
      return {
        value,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes)
      };
    }

    const artifact = await this.writeInspectionArtifact(kind, value, "utf8", extension);
    return {
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
      ref: artifact.ref,
      outputPath: artifact.outputPath,
      outputDir: artifact.outputDir
    };
  }

  private async writeInspectionArtifact(
    kind: string,
    body: string | Buffer,
    encoding: BodyRef["encoding"],
    extension: string,
    outputPath?: string
  ): Promise<InspectionArtifact> {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, encoding === "base64" ? "base64" : "utf8");
    const digest = sha256(bytes);

    if (outputPath) {
      const absoluteOutputPath = resolve(outputPath);
      await mkdir(dirname(absoluteOutputPath), { recursive: true });
      await writeFile(absoluteOutputPath, bytes);
      return {
        outputPath: absoluteOutputPath,
        byteLength: bytes.byteLength,
        sha256: digest
      };
    }

    const activeTrace = this.activeMonitor?.trace;
    if (activeTrace) {
      const ref = await activeTrace.writeArtifact(kind, bytes, encoding, extension);
      return {
        outputDir: activeTrace.outputDir,
        outputPath: join(activeTrace.outputDir, ref.path),
        ref,
        byteLength: ref.byteLength,
        sha256: ref.sha256
      };
    }

    const outputDir = resolve("rawtrace-traces", "inspections", makeInspectionId());
    const bodiesDir = join(outputDir, "bodies");
    await mkdir(bodiesDir, { recursive: true });
    const filename = `${sanitizeFileStem(kind)}_${String(++this.inspectionArtifactSeq).padStart(6, "0")}.${sanitizeFileExtension(extension)}`;
    const absoluteOutputPath = join(bodiesDir, filename);
    await writeFile(absoluteOutputPath, bytes);
    const ref: BodyRef = {
      path: relative(outputDir, absoluteOutputPath).replaceAll("\\", "/"),
      byteLength: bytes.byteLength,
      sha256: digest,
      encoding
    };
    return {
      outputDir,
      outputPath: absoluteOutputPath,
      ref,
      byteLength: bytes.byteLength,
      sha256: digest
    };
  }

  private resolveSession(sessionId?: string): TraceSession {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new RawTraceError("TRACE_SESSION_NOT_FOUND", `Unknown trace session: ${sessionId}`);
      }
      return session;
    }
    if (this.activeMonitor) {
      return this.activeMonitor.trace;
    }
    const latest = [...this.sessions.values()].at(-1);
    if (!latest) {
      throw new RawTraceError("TRACE_SESSION_NOT_FOUND", "No trace session is available.");
    }
    return latest;
  }

  private requireContext(): BrowserContext {
    if (!this.context) {
      throw new RawTraceError("BROWSER_NOT_LAUNCHED", "Call browser_launch before using this tool.");
    }
    return this.context;
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new RawTraceError("BROWSER_NOT_LAUNCHED", "Call browser_launch before using this tool.");
    }
    return this.page;
  }

  private browserInfo(mode: "isolated" | "cdp", detail: string): Record<string, unknown> {
    return {
      browserId: "default",
      contextId: "ctx_default",
      pageId: this.page ? this.pageIdFor(this.page) : undefined,
      mode,
      detail,
      pageUrl: this.page?.url() ?? "about:blank"
    };
  }
}

export function normalizeCaptureOptions(input: MonitorStartInput): CaptureOptions {
  return {
    captureDom: input.captureDom ?? true,
    captureNetwork: input.captureNetwork ?? true,
    captureCookies: input.captureCookies ?? true,
    captureBodies: input.captureBodies ?? true,
    captureWebSockets: input.captureWebSockets ?? true,
    captureConsole: input.captureConsole ?? true,
    captureFrames: input.captureFrames ?? true,
    maxBodyBytes: input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    outputDir: input.outputDir
  };
}

export function assertValidEventStream(stream: string): asserts stream is EventStream | "all" {
  const valid = ["all", "actions", "dom", "network", "cookies", "websocket", "console", "frames"];
  if (!valid.includes(stream)) {
    throw new RawTraceError("INVALID_EVENT_STREAM", `Invalid event stream: ${stream}`);
  }
}

function assertRawCaptureAcknowledged(input: { acknowledgeRawCapture?: boolean }, toolName: string): void {
  if (input.acknowledgeRawCapture !== true) {
    throw new RawTraceError("RAW_CAPTURE_ACK_REQUIRED", `${toolName} requires acknowledgeRawCapture: true.`, {
      warning: RAW_CAPTURE_WARNING
    });
  }
}

function assertDangerousEvalAcknowledged(input: { acknowledgeRawCapture?: boolean; acknowledgeDangerousEval?: boolean }, toolName: string): void {
  assertRawCaptureAcknowledged(input, toolName);
  if (input.acknowledgeDangerousEval !== true) {
    throw new RawTraceError("DANGEROUS_EVAL_ACK_REQUIRED", `${toolName} requires acknowledgeDangerousEval: true.`, {
      warning: DANGEROUS_EVAL_WARNING
    });
  }
}

function assertCredentialAccessAcknowledged(input: { acknowledgeRawCapture?: boolean; acknowledgeCredentialAccess?: boolean }, toolName: string): void {
  assertRawCaptureAcknowledged(input, toolName);
  if (input.acknowledgeCredentialAccess !== true) {
    throw new RawTraceError("CREDENTIAL_ACCESS_ACK_REQUIRED", `${toolName} requires acknowledgeCredentialAccess: true.`, {
      warning: CREDENTIAL_ACCESS_WARNING
    });
  }
}

function assertFileAccessAcknowledged(input: { acknowledgeFileAccess?: boolean }, toolName: string): void {
  if (input.acknowledgeFileAccess !== true) {
    throw new RawTraceError("FILE_ACCESS_ACK_REQUIRED", `${toolName} requires acknowledgeFileAccess: true.`, {
      warning: FILE_ACCESS_WARNING
    });
  }
}

function assertPermissionChangeAcknowledged(input: { acknowledgePermissionChange?: boolean }, toolName: string): void {
  if (input.acknowledgePermissionChange !== true) {
    throw new RawTraceError("PERMISSION_CHANGE_ACK_REQUIRED", `${toolName} requires acknowledgePermissionChange: true.`, {
      warning: PERMISSION_CHANGE_WARNING
    });
  }
}

function assertLocationAccessAcknowledged(input: { acknowledgeLocationAccess?: boolean }, toolName: string): void {
  if (input.acknowledgeLocationAccess !== true) {
    throw new RawTraceError("LOCATION_ACCESS_ACK_REQUIRED", `${toolName} requires acknowledgeLocationAccess: true.`, {
      warning: LOCATION_ACCESS_WARNING
    });
  }
}

function assertStorageStateOverwriteAcknowledged(input: { acknowledgeStorageStateOverwrite?: boolean }, toolName: string): void {
  if (input.acknowledgeStorageStateOverwrite !== true) {
    throw new RawTraceError("STORAGE_STATE_OVERWRITE_ACK_REQUIRED", `${toolName} requires acknowledgeStorageStateOverwrite: true for CDP or persistent profiles.`, {
      warning: STORAGE_STATE_OVERWRITE_WARNING
    });
  }
}

function assertStorageStateOverwriteAcknowledgedForLaunch(input: BrowserLaunchInput): void {
  if (input.cdpUrl || input.userDataDir) {
    assertStorageStateOverwriteAcknowledged(input, "browser_launch");
  }
}

function normalizeMaxBytes(value: number | undefined): number {
  const maxBytes = Math.trunc(value ?? DEFAULT_INSPECTION_MAX_BYTES);
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new RawTraceError("INVALID_MAX_BYTES", "maxBytes must be a non-negative integer.");
  }
  return maxBytes;
}

function normalizeElementsLimit(value: number | undefined): number {
  const limit = Math.trunc(value ?? DEFAULT_GET_ELEMENTS_LIMIT);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RawTraceError("INVALID_LIMIT", "browser_get_elements limit must be a positive integer.");
  }
  if (limit > MAX_GET_ELEMENTS_LIMIT) {
    throw new RawTraceError("LIMIT_TOO_LARGE", `browser_get_elements limit must be <= ${MAX_GET_ELEMENTS_LIMIT}.`, {
      maxLimit: MAX_GET_ELEMENTS_LIMIT,
      requestedLimit: limit
    });
  }
  return limit;
}

function normalizeBoundedLimit(value: number | undefined, defaultValue: number, maxValue: number, toolName: string): number {
  const limit = Math.trunc(value ?? defaultValue);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RawTraceError("INVALID_LIMIT", `${toolName} limit must be a positive integer.`);
  }
  if (limit > maxValue) {
    throw new RawTraceError("LIMIT_TOO_LARGE", `${toolName} limit must be <= ${maxValue}.`, {
      maxLimit: maxValue,
      requestedLimit: limit
    });
  }
  return limit;
}

function normalizeSelectOptionValues(values: BrowserSelectOptionInput["values"]):
  | string
  | { value?: string; label?: string; index?: number }
  | Array<{ value?: string; label?: string; index?: number }> {
  if (Array.isArray(values)) {
    return values.map((value) => (typeof value === "string" ? { value } : value));
  }
  return values;
}

function compileRegex(pattern: string, toolName: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new RawTraceError("INVALID_REGEX", `${toolName} received an invalid urlRegex.`, {
      pattern,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => Promise<Record<string, unknown>>
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  const guardedPromise = promise.then(
    (value) => {
      if (timedOut) {
        return new Promise<T>(() => {});
      }
      return value;
    },
    (error: unknown) => {
      if (timedOut) {
        return new Promise<T>(() => {});
      }
      throw error;
    }
  );
  try {
    return await Promise.race([
      guardedPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          void (async () => {
            let recovery: Record<string, unknown> | undefined;
            try {
              recovery = await onTimeout?.();
            } catch (error) {
              recovery = {
                recovery: "failed",
                error: error instanceof Error ? error.message : String(error)
              };
            }
            reject(new RawTraceError("OPERATION_TIMEOUT", message, { timeoutMs, ...recovery }));
          })();
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function serializeJsonValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  return (
    JSON.stringify(
      value,
      (_key, item: unknown) => {
        if (typeof item === "bigint") {
          return item.toString();
        }
        if (typeof item === "number" && !Number.isFinite(item)) {
          return String(item);
        }
        return item;
      },
      2
    ) ?? "undefined"
  );
}

function networkEventPreview(event: Record<string, unknown>): Record<string, unknown> {
  const preview: Record<string, unknown> = {};
  for (const key of [
    "sessionId",
    "seq",
    "source",
    "type",
    "t",
    "wallTime",
    "pageUrl",
    "requestId",
    "url",
    "documentURL",
    "method",
    "status",
    "statusCode",
    "statusText",
    "resourceType",
    "bodyRef",
    "bodySkipped",
    "bodyError"
  ]) {
    const value = event[key];
    if (value !== undefined) {
      preview[key] = typeof value === "string" && value.length > 500 ? `${value.slice(0, 500)}...` : value;
    }
  }
  return preview;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

async function verifySelectorCandidates(
  page: Page,
  targetHandle: ElementHandle,
  drafts: SelectorCandidateDraft[],
  target: SelectorTargetSummary,
  input: BrowserOptimizeSelectorInput
): Promise<{ accepted: VerifiedSelectorCandidate[]; rejected: RejectedSelectorCandidate[] }> {
  const seen = new Set<string>();
  const accepted: VerifiedSelectorCandidate[] = [];
  const rejected: RejectedSelectorCandidate[] = [];

  for (const draft of drafts) {
    const selector = draft.selector.trim();
    if (!selector || seen.has(selector)) {
      continue;
    }
    seen.add(selector);

    try {
      const candidateLocator = page.locator(selector);
      const count = await candidateLocator.count();
      if (count === 0) {
        rejected.push({ selector, source: draft.source, reason: "no_match", count });
        continue;
      }
      if (count !== 1) {
        rejected.push({ selector, source: draft.source, reason: "not_unique", count });
        continue;
      }

      const candidateHandle = await candidateLocator.first().elementHandle();
      const sameTarget = candidateHandle ? await targetHandle.evaluate((target, candidate) => target === candidate, candidateHandle) : false;
      await candidateHandle?.dispose().catch(() => undefined);
      if (!sameTarget) {
        rejected.push({ selector, source: draft.source, reason: "wrong_target", count });
        continue;
      }

      accepted.push({
        selector,
        count: 1,
        score: scoreSelectorCandidate(draft, target, input),
        source: draft.source,
        reasons: uniqueStrings([...draft.reasons, "unique", "matches_original_target"])
      });
    } catch (error) {
      rejected.push({
        selector,
        source: draft.source,
        reason: "selector_error",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  accepted.sort((a, b) => b.score - a.score || a.selector.length - b.selector.length || a.selector.localeCompare(b.selector));
  return { accepted, rejected };
}

function scoreSelectorCandidate(draft: SelectorCandidateDraft, target: SelectorTargetSummary, input: BrowserOptimizeSelectorInput): number {
  let raw = draft.baseScore;
  if (target.visible) raw += 30;
  if (input.textContains && draft.selector.includes(input.textContains)) raw += 55;
  if (input.name && draft.selector.includes(input.name)) raw += 45;
  if (input.role && draft.selector.includes(input.role)) raw += 25;

  raw -= Math.min(draft.selector.length * 1.2, 180);
  raw -= countOccurrences(draft.selector, ">") * 22;
  raw -= countOccurrences(draft.selector, ":nth-of-type(") * 80;
  raw -= countOccurrences(draft.selector, ":nth-match(") * 120;
  if (isProbablyDynamicSelectorText(draft.selector)) raw -= 350;
  const textMatch = draft.selector.match(/:has-text\((.*)\)/);
  if (textMatch?.[1] && textMatch[1].length > 90) raw -= 140;

  return Math.round(Math.max(0, Math.min(1, raw / 1000)) * 1000) / 1000;
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) return 0;
  return value.split(needle).length - 1;
}

function isProbablyDynamicSelectorText(value: string): boolean {
  return /base-ui-_r_|radix-:r|[_-][a-f0-9]{8,}\b|#[0-9]+\b/i.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function readPageStorage(input: { origin?: string; includeSessionStorage: boolean }): {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
  sessionStorage?: Array<{ name: string; value: string }>;
} {
  if (input.origin && new URL(input.origin).origin !== window.location.origin) {
    throw new Error(`Storage origin mismatch: current=${window.location.origin}, requested=${new URL(input.origin).origin}`);
  }
  const localStorageEntries = Array.from({ length: window.localStorage.length }, (_item, index) => {
    const name = window.localStorage.key(index) ?? "";
    return { name, value: window.localStorage.getItem(name) ?? "" };
  });
  const result: {
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
    sessionStorage?: Array<{ name: string; value: string }>;
  } = {
    origin: window.location.origin,
    localStorage: localStorageEntries
  };
  if (input.includeSessionStorage) {
    result.sessionStorage = Array.from({ length: window.sessionStorage.length }, (_item, index) => {
      const name = window.sessionStorage.key(index) ?? "";
      return { name, value: window.sessionStorage.getItem(name) ?? "" };
    });
  }
  return result;
}

function writePageStorage(input: {
  origin?: string;
  localStorage: Record<string, string | null>;
  sessionStorage: Record<string, string | null>;
}): { origin: string; localStorageChanged: number; sessionStorageChanged: number } {
  if (input.origin && new URL(input.origin).origin !== window.location.origin) {
    throw new Error(`Storage origin mismatch: current=${window.location.origin}, requested=${new URL(input.origin).origin}`);
  }
  let localStorageChanged = 0;
  for (const [name, value] of Object.entries(input.localStorage)) {
    if (value === null) {
      window.localStorage.removeItem(name);
    } else {
      window.localStorage.setItem(name, value);
    }
    localStorageChanged += 1;
  }
  let sessionStorageChanged = 0;
  for (const [name, value] of Object.entries(input.sessionStorage)) {
    if (value === null) {
      window.sessionStorage.removeItem(name);
    } else {
      window.sessionStorage.setItem(name, value);
    }
    sessionStorageChanged += 1;
  }
  return {
    origin: window.location.origin,
    localStorageChanged,
    sessionStorageChanged
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeInspectionId(): string {
  const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const suffix = randomBytes(4).toString("hex");
  return `inspection_${timestamp}_${suffix}`;
}

function sanitizeFileStem(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return clean.length > 0 ? clean : "artifact";
}

function sanitizeFileExtension(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
  return clean.length > 0 ? clean : "bin";
}

function sanitizeDownloadFilename(value: string): string {
  const clean = [...basename(value)]
    .map((char) => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? "_" : char))
    .join("")
    .replace(/^_+|_+$/g, "");
  return clean.length > 0 ? clean : "download.bin";
}

function quoteCssAttribute(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function valueLength(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + String(item).length, 0);
  }
  return String(value ?? "").length;
}

function looksTextContent(contentType: string | undefined): boolean {
  const normalized = contentType?.toLowerCase() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("javascript") ||
    normalized.includes("xml") ||
    normalized.includes("x-www-form-urlencoded")
  );
}

function extensionForContentType(contentType: string | undefined): string {
  const normalized = contentType?.toLowerCase() ?? "";
  if (normalized.includes("json")) return "json";
  if (normalized.includes("html")) return "html";
  if (normalized.includes("javascript")) return "js";
  if (normalized.includes("xml")) return "xml";
  if (normalized.startsWith("text/")) return "txt";
  return "bin";
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function skippedResponseBody(
  byteLength: number,
  maxBytes: number,
  contentType: string | undefined,
  reason: string
): Record<string, unknown> & { byteLength: number } {
  return {
    byteLength,
    contentType,
    maxBytes,
    truncated: true,
    contentSkippedReason: reason
  };
}

function summarizeFormControlForFill(element: Element): Record<string, unknown> {
  const tagName = element.tagName.toLowerCase();
  return {
    tagName,
    type: element instanceof HTMLInputElement ? element.type : undefined,
    name: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element.name || undefined : undefined,
    id: element.id || undefined,
    multiple: element instanceof HTMLSelectElement ? element.multiple : undefined
  };
}

async function fillFormControl(
  locator: Locator,
  field: BrowserFillFormInput["fields"][number],
  timeoutMs: number,
  control: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const tagName = stringValue(control.tagName);
  const type = stringValue(control.type) ?? "";

  if (tagName === "input" && type === "file") {
    throw new RawTraceError("FORM_FILE_INPUT_UNSUPPORTED", "Use browser_upload_file for file inputs.");
  }

  if (tagName === "input" && ["checkbox", "radio"].includes(type)) {
    const checked = field.checked ?? (typeof field.value === "boolean" ? field.value : true);
    if (!checked && type === "radio") {
      throw new RawTraceError("FORM_RADIO_UNCHECK_UNSUPPORTED", "Radio inputs can be checked, but not unchecked as a fill_form operation.");
    }
    if (checked) {
      await locator.check({ timeout: timeoutMs });
    } else {
      await locator.uncheck({ timeout: timeoutMs });
    }
    return {
      action: checked ? "check" : "uncheck",
      checked
    };
  }

  if (tagName === "select") {
    if (field.value === undefined || field.value === null) {
      throw new RawTraceError("FORM_FIELD_VALUE_REQUIRED", "Select fields require value.");
    }
    const values = Array.isArray(field.value) ? field.value : [String(field.value)];
    const selected = await locator.selectOption(values.map((value) => ({ value })), { timeout: timeoutMs });
    return {
      action: "select",
      selected,
      valueLength: valueLength(field.value)
    };
  }

  if (field.value === undefined) {
    throw new RawTraceError("FORM_FIELD_VALUE_REQUIRED", "Text fields require value.");
  }
  const text = field.value === null ? "" : String(field.value);
  await locator.fill(text, { timeout: timeoutMs });
  return {
    action: "fill",
    valueLength: text.length
  };
}

function summarizeForms(input: {
  selector?: string;
  textContains?: string;
  limit: number;
}): { totalForms: number; totalControls: number; forms: Array<Record<string, unknown>> } {
  const controlSelector = "input, textarea, select, button";
  const textNeedle = input.textContains?.toLowerCase();
  const uniqueElements = (elements: Element[]): Element[] => [...new Set(elements)];
  const escapeCss = (value: string): string => {
    const css = (window as unknown as { CSS?: { escape?: (text: string) => string } }).CSS;
    return css?.escape ? css.escape(value) : value.replace(/["\\#.:,[\]>+~*'=()]/g, "\\$&");
  };
  const quoteAttr = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const compact = (value: string | null | undefined, max = 180): string | undefined => {
    const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
  };
  const cssPathFor = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += `#${escapeCss(current.id)}`;
        parts.unshift(part);
        break;
      }
      const parent: Element | null = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current!.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const labelFor = (element: Element): string | undefined => {
    if (element.id) {
      const explicitLabel = document.querySelector(`label[for="${quoteAttr(element.id)}"]`);
      const explicitText = compact(explicitLabel?.textContent);
      if (explicitText) return explicitText;
    }
    const parentLabel = element.closest("label");
    const parentText = compact(parentLabel?.textContent);
    if (parentText) return parentText;
    return undefined;
  };
  const selectorCandidatesFor = (element: Element): string[] => {
    const tagName = element.tagName.toLowerCase();
    const candidates: string[] = [];
    const testAttr = ["data-testid", "data-test", "data-cy"]
      .map((name) => ({ name, value: element.getAttribute(name) }))
      .find((attr): attr is { name: string; value: string } => Boolean(attr.value));
    const name = element.getAttribute("name");
    const ariaLabel = element.getAttribute("aria-label");
    const placeholder = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.placeholder : "";
    if (element.id) candidates.push(`#${escapeCss(element.id)}`);
    if (testAttr) candidates.push(`[${testAttr.name}="${quoteAttr(testAttr.value)}"]`);
    if (name) candidates.push(`${tagName}[name="${quoteAttr(name)}"]`);
    if (ariaLabel) candidates.push(`[aria-label="${quoteAttr(ariaLabel)}"]`);
    if (placeholder) candidates.push(`${tagName}[placeholder="${quoteAttr(placeholder)}"]`);
    candidates.push(cssPathFor(element));
    return [...new Set(candidates)].slice(0, 6);
  };
  const visibleFor = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const summarizeControl = (element: Element, index: number): Record<string, unknown> => {
    const tagName = element.tagName.toLowerCase();
    const inputElement = element instanceof HTMLInputElement ? element : undefined;
    const textElement = element instanceof HTMLTextAreaElement ? element : undefined;
    const selectElement = element instanceof HTMLSelectElement ? element : undefined;
    const buttonElement = element instanceof HTMLButtonElement ? element : undefined;
    const rect = element.getBoundingClientRect();
    return {
      index,
      tagName,
      type: inputElement?.type ?? buttonElement?.type,
      id: element.id || undefined,
      name: inputElement?.name || textElement?.name || selectElement?.name || buttonElement?.name || undefined,
      label: labelFor(element),
      placeholder: inputElement?.placeholder || textElement?.placeholder || undefined,
      value:
        inputElement?.type === "file"
          ? Array.from(inputElement.files ?? []).map((file) => file.name)
          : (inputElement?.value ?? textElement?.value ?? selectElement?.value ?? buttonElement?.value ?? undefined),
      checked: inputElement && ["checkbox", "radio"].includes(inputElement.type) ? inputElement.checked : undefined,
      disabled: inputElement?.disabled ?? textElement?.disabled ?? selectElement?.disabled ?? buttonElement?.disabled ?? false,
      multiple: selectElement?.multiple,
      options: selectElement
        ? Array.from(selectElement.options).map((option) => ({
            value: option.value,
            label: compact(option.label || option.textContent),
            selected: option.selected
          }))
        : undefined,
      visible: visibleFor(element),
      boundingBox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      selectorCandidates: selectorCandidatesFor(element)
    };
  };
  const summarizeForm = (form: HTMLFormElement | undefined, controls: Element[], index: number): Record<string, unknown> => {
    const formSummary = form
      ? {
          index,
          synthetic: false,
          id: form.id || undefined,
          name: form.name || undefined,
          method: form.method || undefined,
          action: form.action || undefined,
          selectorCandidates: selectorCandidatesFor(form)
        }
      : {
          index,
          synthetic: true
        };
    const controlSummaries = controls.map((control, controlIndex) => summarizeControl(control, controlIndex));
    return {
      ...formSummary,
      controlCount: controlSummaries.length,
      controls: controlSummaries
    };
  };
  const matchesNeedle = (form: Record<string, unknown>): boolean => {
    if (!textNeedle) return true;
    return JSON.stringify(form).toLowerCase().includes(textNeedle);
  };

  const selected = input.selector ? Array.from(document.querySelectorAll(input.selector)) : Array.from(document.forms);
  const formElements = input.selector
    ? uniqueElements(
        selected.flatMap((element) => [
          ...(element instanceof HTMLFormElement ? [element] : []),
          ...Array.from(element.querySelectorAll("form"))
        ])
      ).filter((element): element is HTMLFormElement => element instanceof HTMLFormElement)
    : selected.filter((element): element is HTMLFormElement => element instanceof HTMLFormElement);
  const selectedControls = input.selector
    ? uniqueElements(
        selected.flatMap((element) => [
          ...(element.matches(controlSelector) ? [element] : []),
          ...Array.from(element.querySelectorAll(controlSelector))
        ])
      )
    : selected.filter((element) => element.matches(controlSelector));
  const forms: Array<Record<string, unknown>> = [];
  const seenControls = new Set<Element>();

  for (const form of formElements) {
    const controls = Array.from(form.querySelectorAll(controlSelector));
    controls.forEach((control) => seenControls.add(control));
    forms.push(summarizeForm(form, controls, forms.length));
  }

  const orphanControls = input.selector
    ? selectedControls.filter((control) => !seenControls.has(control))
    : Array.from(document.querySelectorAll(controlSelector)).filter((control) => !control.closest("form"));
  if (orphanControls.length > 0) {
    forms.push(summarizeForm(undefined, orphanControls, forms.length));
  }

  const filtered = forms.filter(matchesNeedle);
  const totalControls = filtered.reduce((total, form) => total + Number(form.controlCount ?? 0), 0);
  return {
    totalForms: filtered.length,
    totalControls,
    forms: filtered.slice(0, input.limit)
  };
}

function summarizeActiveElement(): Record<string, unknown> | null {
  const element = document.activeElement;
  if (!element || !(element instanceof Element)) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;
  return {
    tagName: element.tagName.toLowerCase(),
    id: element.id || undefined,
    type: input instanceof HTMLInputElement ? input.type : undefined,
    name: input?.name || element.getAttribute("name") || undefined,
    role: element.getAttribute("role") || undefined,
    placeholder: input?.placeholder || undefined,
    ariaLabel: element.getAttribute("aria-label") || undefined,
    text: text ? text.slice(0, 200) : undefined,
    visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
    boundingBox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };
}

function buildSelectorOptimizationScan(
  element: Element,
  input: {
    selector: string;
    targetIndex: number;
    textContains?: string;
    role?: string;
    name?: string;
  }
): SelectorOptimizationScan {
  const candidates: SelectorCandidateDraft[] = [];
  const seen = new Set<string>();

  const escapeCss = (value: string): string => {
    const css = (window as unknown as { CSS?: { escape?: (text: string) => string } }).CSS;
    return css?.escape ? css.escape(value) : value.replace(/["\\#.:,[\]>+~*'=()]/g, "\\$&");
  };
  const quoteAttr = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const quoteText = (value: string): string => JSON.stringify(value);
  const normalizeText = (value: string | null | undefined): string => String(value ?? "").replace(/\s+/g, " ").trim();
  const compact = (value: string | null | undefined, max: number): string | undefined => {
    const normalized = normalizeText(value);
    if (!normalized) return undefined;
    return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
  };
  const selectorText = (value: string | null | undefined, max = 80): string | undefined => {
    const normalized = normalizeText(value);
    if (!normalized) return undefined;
    return normalized.length > max ? normalized.slice(0, max) : normalized;
  };
  const isProbablyStableId = (value: string | null | undefined): value is string => {
    if (!value) return false;
    if (/^base-ui-_r_/i.test(value)) return false;
    if (/^radix-:r/i.test(value)) return false;
    if (/^\d+$/.test(value)) return false;
    if (/^[a-f0-9]{8,}$/i.test(value)) return false;
    if (/[a-f0-9]{10,}/i.test(value) && !/[g-z]/i.test(value)) return false;
    return true;
  };
  const roleFor = (target: Element, tagName: string): string | undefined => {
    const explicit = target.getAttribute("role");
    if (explicit) return explicit;
    if (tagName === "a") return "link";
    if (tagName === "button") return "button";
    if (tagName === "select") return "combobox";
    if (tagName === "textarea") return "textbox";
    if (target instanceof HTMLInputElement) {
      if (["button", "submit", "reset"].includes(target.type)) return "button";
      if (target.type === "checkbox") return "checkbox";
      if (target.type === "radio") return "radio";
      return "textbox";
    }
    return undefined;
  };
  const labelFor = (target: Element): string | undefined => {
    const ariaLabel = target.getAttribute("aria-label");
    if (ariaLabel) return compact(ariaLabel, 180);
    const labelledBy = target.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const compactLabel = compact(label, 180);
      if (compactLabel) return compactLabel;
    }
    if (target.id) {
      const explicitLabel = document.querySelector(`label[for="${quoteAttr(target.id)}"]`);
      const explicitText = compact(explicitLabel?.textContent, 180);
      if (explicitText) return explicitText;
    }
    const wrappedLabel = target.closest("label");
    const wrappedText = compact(wrappedLabel?.textContent, 180);
    if (wrappedText) return wrappedText;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      if (target.placeholder) return compact(target.placeholder, 180);
      if (target.name) return compact(target.name, 180);
    }
    return compact(target instanceof HTMLElement ? target.innerText : target.textContent, 180);
  };
  const addCandidate = (selector: string | undefined, source: string, baseScore: number, reasons: string[]): void => {
    const normalized = selector?.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ selector: normalized, source, baseScore, reasons });
  };
  const stableDataAttr = (target: Element): { name: string; value: string } | undefined => {
    for (const name of ["data-testid", "data-test", "data-cy"]) {
      const value = target.getAttribute(name);
      if (value) return { name, value };
    }
    return undefined;
  };
  const segmentFor = (target: Element): string => {
    const tagName = target.tagName.toLowerCase();
    if (isProbablyStableId(target.id)) return `${tagName}#${escapeCss(target.id)}`;
    const dataAttr = stableDataAttr(target);
    if (dataAttr) return `${tagName}[${dataAttr.name}="${quoteAttr(dataAttr.value)}"]`;
    const parent = target.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === target.tagName);
      if (sameTag.length > 1) return `${tagName}:nth-of-type(${sameTag.indexOf(target) + 1})`;
    }
    return tagName;
  };
  const cssSegmentsFor = (target: Element, maxDepth = 7): string[] => {
    const parts: string[] = [];
    let current: Element | null = target;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < maxDepth) {
      parts.unshift(segmentFor(current));
      if (isProbablyStableId(current.id)) break;
      current = current.parentElement;
    }
    return parts;
  };
  const stripNth = (selector: string): string => selector.replace(/:nth-of-type\(\d+\)/g, "").replace(/\s*>\s*/g, " > ").trim();
  const targetTextSelector = (tagName: string, role: string | undefined, text: string | undefined): string | undefined => {
    const shortText = selectorText(text, 80);
    if (!shortText) return undefined;
    if (tagName === "button" || tagName === "a") return `${tagName}:has-text(${quoteText(shortText)})`;
    if (role === "button" || role === "link") return `[role="${quoteAttr(role)}"]:has-text(${quoteText(shortText)})`;
    return undefined;
  };
  const targetTextSelectorDrafts = (tagName: string, role: string | undefined, text: string | undefined): Array<{ selector: string; source: string; baseScore: number; anchorScore: number; reasons: string[] }> => {
    const drafts: Array<{ selector: string; source: string; baseScore: number; anchorScore: number; reasons: string[] }> = [];
    const addTextDraft = (value: string | undefined, source: string, baseScore: number, anchorScore: number, reasons: string[]): void => {
      const selector = targetTextSelector(tagName, role, value);
      if (!selector) return;
      drafts.push({ selector, source, baseScore, anchorScore, reasons });
    };

    addTextDraft(text, "visible_text", 900, 920, ["visible_text", "actual_target_text"]);
    addTextDraft(input.name, "text_hint", 800, 850, ["name_hint"]);
    addTextDraft(input.textContains, "text_hint", 770, 830, ["text_contains_hint"]);
    return drafts;
  };

  const tagName = element.tagName.toLowerCase();
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const inputElement = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;
  const role = input.role || roleFor(element, tagName);
  const text = compact(element instanceof HTMLElement ? element.innerText : element.textContent, 220);
  const name = compact(input.name || labelFor(element), 220);
  const ariaLabel = element.getAttribute("aria-label") || undefined;
  const placeholder = inputElement?.placeholder || undefined;
  const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  const target: SelectorTargetSummary = {
    tagName,
    id: element.id || undefined,
    type: inputElement instanceof HTMLInputElement ? inputElement.type : undefined,
    role,
    name,
    text,
    placeholder,
    ariaLabel,
    visible,
    boundingBox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  };

  addCandidate(input.selector, "input_selector", 320, ["original_selector"]);

  const dataAttr = stableDataAttr(element);
  if (dataAttr) {
    addCandidate(`[${dataAttr.name}="${quoteAttr(dataAttr.value)}"]`, "stable_attribute", 980, [`${dataAttr.name}_attribute`]);
    addCandidate(`${tagName}[${dataAttr.name}="${quoteAttr(dataAttr.value)}"]`, "stable_attribute", 990, [`${dataAttr.name}_attribute`, "tag_scoped"]);
  }

  if (isProbablyStableId(element.id)) {
    addCandidate(`#${escapeCss(element.id)}`, "stable_id", 930, ["stable_id"]);
    addCandidate(`${tagName}#${escapeCss(element.id)}`, "stable_id", 940, ["stable_id", "tag_scoped"]);
  } else if (element.id) {
    addCandidate(`${tagName}#${escapeCss(element.id)}`, "unstable_id", 180, ["dynamic_id_fallback"]);
  }

  if (ariaLabel) {
    addCandidate(`[aria-label="${quoteAttr(ariaLabel)}"]`, "stable_attribute", 900, ["aria_label"]);
    addCandidate(`${tagName}[aria-label="${quoteAttr(ariaLabel)}"]`, "stable_attribute", 920, ["aria_label", "tag_scoped"]);
  }
  const nameAttr = element.getAttribute("name");
  if (nameAttr) {
    addCandidate(`${tagName}[name="${quoteAttr(nameAttr)}"]`, "stable_attribute", 880, ["name_attribute"]);
  }
  if (placeholder && (tagName === "input" || tagName === "textarea")) {
    addCandidate(`${tagName}[placeholder="${quoteAttr(placeholder)}"]`, "stable_attribute", 870, ["placeholder"]);
  }

  const textSelectorDrafts = targetTextSelectorDrafts(tagName, role, text);
  for (const textSelector of textSelectorDrafts) {
    addCandidate(textSelector.selector, textSelector.source, textSelector.baseScore, textSelector.reasons);
  }
  if (role && name) {
    const roleText = selectorText(name, 80);
    if (roleText) {
      addCandidate(`[role="${quoteAttr(role)}"]:has-text(${quoteText(roleText)})`, "role_text", 830, ["role", "accessible_name"]);
    }
  }

  const ancestorSegments = cssSegmentsFor(element);
  for (let index = 0; index < ancestorSegments.length; index++) {
    const suffix = ancestorSegments.slice(index).join(" > ");
    addCandidate(suffix, index === 0 ? "css_path" : "css_reduced", index === 0 ? 430 : 520, ["structural_path"]);
    const noNth = stripNth(suffix);
    if (noNth !== suffix) addCandidate(noNth, "css_reduced", 560, ["removed_nth_of_type"]);
  }

  let ancestor: Element | null = element.parentElement;
  let depth = 0;
  while (ancestor && depth < 5) {
    const ancestorTag = ancestor.tagName.toLowerCase();
    const ancestorData = stableDataAttr(ancestor);
    if (ancestorData) {
      for (const targetTextForAnchor of textSelectorDrafts) {
        addCandidate(
          `[${ancestorData.name}="${quoteAttr(ancestorData.value)}"] ${targetTextForAnchor.selector}`,
          "semantic_anchor",
          targetTextForAnchor.anchorScore,
          ["stable_ancestor", ...targetTextForAnchor.reasons]
        );
      }
    }

    const heading = Array.from(ancestor.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']")).find((candidate) => {
      if (element.contains(candidate)) return false;
      return Boolean(selectorText(candidate.textContent, 80));
    });
    const headingText = selectorText(heading?.textContent, 80);
    if (heading && headingText) {
      const headingTag = heading.tagName.toLowerCase();
      const headingSelector = heading.getAttribute("role") === "heading" && !/^h[1-6]$/.test(headingTag) ? `[role="heading"]:has-text(${quoteText(headingText)})` : `${headingTag}:has-text(${quoteText(headingText)})`;
      for (const targetTextForAnchor of textSelectorDrafts) {
        addCandidate(
          `${ancestorTag}:has(${headingSelector}) ${targetTextForAnchor.selector}`,
          "semantic_anchor",
          targetTextForAnchor.anchorScore,
          ["nearby_heading", ...targetTextForAnchor.reasons]
        );
      }
    }
    ancestor = ancestor.parentElement;
    depth += 1;
  }

  return {
    target,
    candidates: candidates.slice(0, 250)
  };
}

function summarizeInteractiveElements(input: {
  selector?: string;
  textContains?: string;
  limit: number;
}): { total: number; elements: Array<Record<string, unknown>> } {
  const defaultSelector = [
    "button",
    "a[href]",
    "input",
    "textarea",
    "select",
    "[role]",
    "[onclick]",
    "[tabindex]:not([tabindex='-1'])"
  ].join(", ");
  const querySelector = input.selector || defaultSelector;
  const textNeedle = input.textContains?.toLowerCase();

  const escapeCss = (value: string): string => {
    const css = (window as unknown as { CSS?: { escape?: (text: string) => string } }).CSS;
    if (css?.escape) {
      return css.escape(value);
    }
    return value.replace(/["\\#.:,[\]>+~*'=()]/g, "\\$&");
  };
  const quoteAttr = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const compact = (value: string | null | undefined, max = 160): string | undefined => {
    const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
  };
  const visibleFor = (element: Element, rect: DOMRect): boolean => {
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const cssPathFor = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += `#${escapeCss(current.id)}`;
        parts.unshift(part);
        break;
      }
      const parent: Element | null = current.parentElement;
      if (parent) {
        const currentTagName = current.tagName;
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === currentTagName);
        if (sameTag.length > 1) {
          part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const candidatesFor = (element: Element, tagName: string, text: string | undefined, role: string | undefined): string[] => {
    const candidates: string[] = [];
    const testAttr = ["data-testid", "data-test", "data-cy"]
      .map((name) => ({ name, value: element.getAttribute(name) }))
      .find((attr): attr is { name: string; value: string } => Boolean(attr.value));
    const ariaLabel = element.getAttribute("aria-label");
    const placeholder =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.placeholder : undefined;

    if (element.id) candidates.push(`#${escapeCss(element.id)}`);
    if (testAttr) candidates.push(`[${testAttr.name}="${quoteAttr(testAttr.value)}"]`);
    if (ariaLabel) candidates.push(`[aria-label="${quoteAttr(ariaLabel)}"]`);
    if (placeholder && (tagName === "input" || tagName === "textarea")) {
      candidates.push(`${tagName}[placeholder="${quoteAttr(placeholder)}"]`);
    }
    if (textNeedle && text?.toLowerCase().includes(textNeedle) && (tagName === "button" || role === "button")) {
      candidates.push(`button:has-text("${quoteAttr(input.textContains ?? textNeedle)}")`);
    }
    if (textNeedle && text?.toLowerCase().includes(textNeedle) && tagName === "a") {
      candidates.push(`a:has-text("${quoteAttr(input.textContains ?? textNeedle)}")`);
    }
    if (text && (tagName === "button" || role === "button")) {
      candidates.push(`button:has-text("${quoteAttr(text.slice(0, 80))}")`);
    }
    if (text && tagName === "a") {
      candidates.push(`a:has-text("${quoteAttr(text.slice(0, 80))}")`);
    }
    candidates.push(cssPathFor(element));
    return [...new Set(candidates)].slice(0, 5);
  };

  const elements = Array.from(document.querySelectorAll(querySelector));
  const matches: Array<{ index: number; rank: number; value: Record<string, unknown> }> = [];
  const rankElement = (element: Element, tagName: string, role: string | undefined, name: string | undefined, text: string | undefined, rect: DOMRect, visible: boolean): number => {
    let rank = visible ? 0 : 10_000;
    const isPrimaryInteractive =
      tagName === "button" ||
      tagName === "input" ||
      tagName === "textarea" ||
      tagName === "select" ||
      role === "button" ||
      role === "link" ||
      role === "checkbox" ||
      role === "radio";
    const isSecondaryInteractive = tagName === "a" || element.hasAttribute("onclick") || element.hasAttribute("tabindex") || Boolean(role);
    if (isPrimaryInteractive) rank -= 300;
    else if (isSecondaryInteractive) rank -= 120;

    if (textNeedle) {
      const label = (name || text || "").toLowerCase();
      if (label === textNeedle) rank -= 700;
      else if (label.startsWith(textNeedle)) rank -= 450;
      else if (label.includes(textNeedle)) rank -= 200;

      rank += Math.min((name || text || "").length, 500);
      rank += Math.min((rect.width * rect.height) / 1500, 300);
      rank += Math.min(element.children.length * 8, 160);
    }
    return rank;
  };

  for (const element of elements) {
    const tagName = element.tagName.toLowerCase();
    const rect = element.getBoundingClientRect();
    const role = element.getAttribute("role") || undefined;
    const text = compact(element.textContent);
    const inputElement = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;
    const placeholder = inputElement?.placeholder || undefined;
    const ariaLabel = element.getAttribute("aria-label") || undefined;
    const ariaDisabled = element.getAttribute("aria-disabled") === "true";
    const nativeDisabled =
      element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement
        ? element.disabled
        : false;
    const labelElement = element.id ? document.querySelector(`label[for="${quoteAttr(element.id)}"]`) : null;
    const labelText = compact(labelElement?.textContent);
    const name = compact(ariaLabel || labelText || text || placeholder || inputElement?.name || element.getAttribute("name"));
    const searchable = [text, name, placeholder, ariaLabel, role, inputElement?.name, element.getAttribute("href")]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (textNeedle && !searchable.includes(textNeedle)) {
      continue;
    }

    const visible = visibleFor(element, rect);
    const value = {
      tagName,
      id: element.id || undefined,
      type: inputElement instanceof HTMLInputElement ? inputElement.type : undefined,
      role,
      name,
      text,
      placeholder,
      ariaLabel,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      disabled: nativeDisabled || ariaDisabled,
      checked: inputElement instanceof HTMLInputElement && ["checkbox", "radio"].includes(inputElement.type) ? inputElement.checked : undefined,
      visible,
      boundingBox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      selectorCandidates: candidatesFor(element, tagName, text, role)
    };
    matches.push({
      index: matches.length,
      rank: rankElement(element, tagName, role, name, text, rect, visible),
      value
    });
  }

  const sorted = [...matches].sort((a, b) => a.rank - b.rank || a.index - b.index).map((match) => match.value);

  return {
    total: matches.length,
    elements: sorted.slice(0, input.limit)
  };
}

function summarizeAccessibilityElements(input: {
  selector?: string;
  textContains?: string;
  limit: number;
}): { total: number; elements: Array<Record<string, unknown>> } {
  const defaultSelector = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "button",
    "a[href]",
    "input",
    "textarea",
    "select",
    "label",
    "main",
    "nav",
    "header",
    "footer",
    "section",
    "article",
    "[role]",
    "[aria-label]",
    "[aria-labelledby]"
  ].join(", ");
  const querySelector = input.selector || defaultSelector;
  const textNeedle = input.textContains?.toLowerCase();

  const escapeCss = (value: string): string => {
    const css = (window as unknown as { CSS?: { escape?: (text: string) => string } }).CSS;
    return css?.escape ? css.escape(value) : value.replace(/["\\#.:,[\]>+~*'=()]/g, "\\$&");
  };
  const quoteAttr = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const compact = (value: string | null | undefined, max = 180): string | undefined => {
    const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
  };
  const cssPathFor = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += `#${escapeCss(current.id)}`;
        parts.unshift(part);
        break;
      }
      const parent: Element | null = current.parentElement;
      if (parent) {
        const currentTagName = current.tagName;
        const siblings = Array.from(parent.children).filter((child): child is Element => child instanceof Element && child.tagName === currentTagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const labelFor = (element: Element): string | undefined => {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return compact(ariaLabel);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const compactLabel = compact(label);
      if (compactLabel) return compactLabel;
    }
    if (element.id) {
      const label = document.querySelector(`label[for="${quoteAttr(element.id)}"]`);
      const labelText = compact(label?.textContent);
      if (labelText) return labelText;
    }
    return compact(element.textContent);
  };
  const roleFor = (element: Element, tagName: string): string | undefined => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    if (/^h[1-6]$/.test(tagName)) return "heading";
    if (tagName === "a") return "link";
    if (tagName === "button") return "button";
    if (tagName === "select") return "combobox";
    if (tagName === "textarea") return "textbox";
    if (tagName === "main") return "main";
    if (tagName === "nav") return "navigation";
    if (tagName === "header") return "banner";
    if (tagName === "footer") return "contentinfo";
    if (tagName === "section") return "region";
    if (tagName === "article") return "article";
    if (element instanceof HTMLInputElement) {
      if (["button", "submit", "reset"].includes(element.type)) return "button";
      if (element.type === "checkbox") return "checkbox";
      if (element.type === "radio") return "radio";
      return "textbox";
    }
    return undefined;
  };
  const selectorCandidatesFor = (element: Element, tagName: string, name: string | undefined): string[] => {
    const candidates: string[] = [];
    const testAttr = ["data-testid", "data-test", "data-cy"]
      .map((attrName) => ({ name: attrName, value: element.getAttribute(attrName) }))
      .find((attr): attr is { name: string; value: string } => Boolean(attr.value));
    const ariaLabel = element.getAttribute("aria-label");
    if (element.id) candidates.push(`#${escapeCss(element.id)}`);
    if (testAttr) candidates.push(`[${testAttr.name}="${quoteAttr(testAttr.value)}"]`);
    if (ariaLabel) candidates.push(`[aria-label="${quoteAttr(ariaLabel)}"]`);
    if (textNeedle && name?.toLowerCase().includes(textNeedle) && ["button", "a"].includes(tagName)) {
      candidates.push(`${tagName}:has-text("${quoteAttr(input.textContains ?? textNeedle)}")`);
    }
    if (name && ["button", "a"].includes(tagName)) candidates.push(`${tagName}:has-text("${quoteAttr(name.slice(0, 80))}")`);
    candidates.push(cssPathFor(element));
    return [...new Set(candidates)].slice(0, 5);
  };

  const elements = Array.from(document.querySelectorAll(querySelector));
  const matches: Array<{ index: number; rank: number; value: Record<string, unknown> }> = [];
  const rankElement = (element: Element, tagName: string, role: string | undefined, name: string | undefined, text: string | undefined, rect: DOMRect, visible: boolean): number => {
    let rank = visible ? 0 : 10_000;
    const rolePriority = new Map<string, number>([
      ["button", -350],
      ["link", -300],
      ["checkbox", -300],
      ["radio", -300],
      ["textbox", -260],
      ["combobox", -260],
      ["heading", -180],
      ["navigation", -80],
      ["main", -40],
      ["region", -20],
      ["article", -20]
    ]);
    rank += role ? rolePriority.get(role) ?? -60 : 0;
    if (textNeedle) {
      const label = (name || text || "").toLowerCase();
      if (label === textNeedle) rank -= 700;
      else if (label.startsWith(textNeedle)) rank -= 450;
      else if (label.includes(textNeedle)) rank -= 200;
      rank += Math.min((name || text || "").length, 600);
      rank += Math.min((rect.width * rect.height) / 1800, 300);
      rank += Math.min(element.children.length * 8, 160);
    }
    return rank;
  };
  for (const element of elements) {
    const tagName = element.tagName.toLowerCase();
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const role = roleFor(element, tagName);
    const name = labelFor(element);
    const text = compact(element.textContent);
    const searchable = [role, name, text, element.getAttribute("placeholder"), element.getAttribute("href")]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (textNeedle && !searchable.includes(textNeedle)) {
      continue;
    }

    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    const value = {
      tagName,
      role,
      name,
      text,
      level: /^h[1-6]$/.test(tagName) ? Number(tagName.slice(1)) : undefined,
      id: element.id || undefined,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      placeholder: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.placeholder || undefined : undefined,
      visible,
      boundingBox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      selectorCandidates: selectorCandidatesFor(element, tagName, name)
    };
    matches.push({
      index: matches.length,
      rank: rankElement(element, tagName, role, name, text, rect, visible),
      value
    });
  }

  const sorted = [...matches].sort((a, b) => a.rank - b.rank || a.index - b.index).map((match) => match.value);

  return {
    total: matches.length,
    elements: sorted.slice(0, input.limit)
  };
}
