import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import yazl from "yazl";
import {
  DEFAULT_READ_EVENTS_LIMIT,
  DEFAULT_SEARCH_EVENTS_LIMIT,
  DEFAULT_SEARCH_BODIES_LIMIT,
  DOM_INLINE_HTML_LIMIT,
  DOM_INLINE_TEXT_LIMIT,
  EVENT_STREAMS,
  MAX_READ_EVENTS_LIMIT,
  MAX_SEARCH_BODIES_LIMIT,
  MAX_SEARCH_EVENTS_LIMIT,
  TRACE_SCHEMA_VERSION
} from "../constants.js";
import { RawTraceError } from "../errors.js";
import type {
  BodyRef,
  CaptureOptions,
  EventCounts,
  EventStream,
  SearchBodiesInput,
  SearchBodyMatch,
  SearchEventMatch,
  SearchEventsInput,
  TraceEvent,
  TraceManifest
} from "../types.js";

export interface TraceSessionOptions {
  captureOptions: CaptureOptions;
  baseOutputDir: string;
  pageUrlProvider?: () => string;
}

export class TraceSession {
  readonly sessionId: string;
  readonly outputDir: string;
  readonly createdAt: string;
  readonly timeOrigin: number;
  readonly captureOptions: CaptureOptions;

  private readonly startPerf: number;
  private readonly pageUrlProvider?: () => string;
  private seq = 0;
  private bodySeq = 0;
  private stoppedAt?: string;
  private closed = false;
  private closing = false;
  private appendQueue: Promise<void> = Promise.resolve();
  private appendFailures: unknown[] = [];
  private readonly writers = new Map<EventStream, NdjsonStreamWriter>();

  readonly eventCounts: EventCounts = {
    actions: 0,
    dom: 0,
    network: 0,
    cookies: 0,
    websocket: 0,
    console: 0,
    frames: 0
  };

  lastEventWallTimeMs: number;

  private constructor(options: TraceSessionOptions, outputDir: string, sessionId: string) {
    this.sessionId = sessionId;
    this.outputDir = outputDir;
    this.captureOptions = options.captureOptions;
    this.pageUrlProvider = options.pageUrlProvider;
    this.createdAt = new Date().toISOString();
    this.timeOrigin = Date.now();
    this.startPerf = performance.now();
    this.lastEventWallTimeMs = Date.now();
  }

  static async create(options: TraceSessionOptions): Promise<TraceSession> {
    const sessionId = makeSessionId();
    const outputDir = resolve(options.baseOutputDir, sessionId);
    const session = new TraceSession(options, outputDir, sessionId);

    await mkdir(outputDir, { recursive: true });
    await mkdir(join(outputDir, "bodies"), { recursive: true });
    await mkdir(join(outputDir, "snapshots"), { recursive: true });
    for (const stream of EVENT_STREAMS) {
      session.writers.set(stream, new NdjsonStreamWriter(session.streamPath(stream)));
    }
    await Promise.all([...session.writers.values()].map((writer) => writer.ready()));
    await session.writeManifest("running");

    return session;
  }

  async append(source: EventStream, type: string, payload: Record<string, unknown> = {}): Promise<TraceEvent> {
    if (this.closed || this.closing) {
      throw new RawTraceError("TRACE_SESSION_CLOSED", `Trace session is already closed: ${this.sessionId}`);
    }

    const operation = this.appendQueue.then(() => this.appendNow(source, type, payload));
    this.appendQueue = operation.then(
      () => undefined,
      (error) => {
        this.appendFailures.push(error);
      }
    );
    return operation;
  }

  private async appendNow(source: EventStream, type: string, payload: Record<string, unknown> = {}): Promise<TraceEvent> {
    if (this.closed) {
      throw new RawTraceError("TRACE_SESSION_CLOSED", `Trace session is already closed: ${this.sessionId}`);
    }

    const payloadFields = await this.preparePayload(source, protectCommonEventFields(payload));
    const event: TraceEvent = {
      ...payloadFields,
      sessionId: this.sessionId,
      seq: ++this.seq,
      source,
      type,
      timeOrigin: this.timeOrigin,
      t: roundMillis(performance.now() - this.startPerf),
      wallTime: new Date().toISOString(),
      pageUrl: this.currentPageUrl()
    };

    this.eventCounts[source] += 1;
    this.lastEventWallTimeMs = Date.now();

    const line = `${JSON.stringify(event)}\n`;
    await this.writer(source).write(line);

    return event;
  }

  async writeBody(kind: "req" | "res" | "ws", body: string | Buffer, encoding: BodyRef["encoding"]): Promise<BodyRef> {
    return this.writePayloadFile(kind, body, encoding);
  }

  async writeDomArtifact(kind: "html" | "text", body: string): Promise<BodyRef> {
    return this.writePayloadFile(`dom_${kind}`, body, "utf8");
  }

  async writeArtifact(
    kind: string,
    body: string | Buffer,
    encoding: BodyRef["encoding"],
    extension = "bin"
  ): Promise<BodyRef> {
    return this.writePayloadFile(kind, body, encoding, extension);
  }

  private async writePayloadFile(kind: string, body: string | Buffer, encoding: BodyRef["encoding"], extension = "bin"): Promise<BodyRef> {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, encoding === "base64" ? "base64" : "utf8");
    const filename = `${sanitizeFileStem(kind)}_${String(++this.bodySeq).padStart(6, "0")}.${sanitizeFileExtension(extension)}`;
    const absolutePath = join(this.outputDir, "bodies", filename);
    await writeFile(absolutePath, bytes);

    return {
      path: `bodies/${filename}`,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      encoding
    };
  }

  async writeSnapshot(name: "initial-dom.html" | "final-dom.html", html: string): Promise<string> {
    const relativePath = `snapshots/${name}`;
    await writeFile(join(this.outputDir, relativePath), html, "utf8");
    return relativePath;
  }

  async stop(): Promise<TraceManifest> {
    this.closing = true;
    this.stoppedAt = new Date().toISOString();
    await this.flush();
    await Promise.all([...this.writers.values()].map((writer) => writer.close()));
    this.closed = true;
    return this.writeManifest("stopped");
  }

  async flush(): Promise<void> {
    await this.appendQueue;
    if (this.appendFailures.length > 0) {
      const failures = this.appendFailures.splice(0);
      throw new RawTraceError("TRACE_APPEND_FAILED", "One or more trace append operations failed.", {
        failures: failures.map((failure) => (failure instanceof Error ? failure.message : String(failure)))
      });
    }
    await Promise.all([...this.writers.values()].map((writer) => writer.flush()));
  }

  async readEvents(stream: EventStream | "all", offset = 0, limit = DEFAULT_READ_EVENTS_LIMIT): Promise<{ events: TraceEvent[]; total: number }> {
    const safeOffset = Math.max(0, Math.trunc(offset));
    const safeLimit = normalizeLimit(limit, MAX_READ_EVENTS_LIMIT, "monitor_read_events");
    await this.flush();

    if (stream === "all") {
      return this.readMergedEvents(safeOffset, safeLimit);
    }

    return this.readSingleStreamEvents(stream, safeOffset, safeLimit);
  }

  async searchEvents(input: SearchEventsInput = {}): Promise<{ matches: SearchEventMatch[]; totalScanned: number; hasMore: boolean }> {
    const stream = input.stream ?? "all";
    const limit = normalizeLimit(input.limit ?? DEFAULT_SEARCH_EVENTS_LIMIT, MAX_SEARCH_EVENTS_LIMIT, "monitor_search_events");
    const sinceSeq = Math.max(0, Math.trunc(input.sinceSeq ?? 0));
    const matches: SearchEventMatch[] = [];
    let totalScanned = 0;
    let hasMore = false;

    for await (const event of this.iterateEvents(stream)) {
      if (event.seq <= sinceSeq) {
        continue;
      }
      totalScanned += 1;
      const searchMatch = await this.eventMatchesSearch(event, input);
      if (!searchMatch.matched) {
        continue;
      }
      if (matches.length >= limit) {
        hasMore = true;
        break;
      }
      matches.push(toSearchMatch(event, searchMatch.snippet));
    }

    return { matches, totalScanned, hasMore };
  }

  async searchBodies(input: SearchBodiesInput): Promise<{ matches: SearchBodyMatch[]; totalScanned: number; hasMore: boolean }> {
    const limit = normalizeLimit(input.limit ?? DEFAULT_SEARCH_BODIES_LIMIT, MAX_SEARCH_BODIES_LIMIT, "monitor_search_bodies");
    const sinceSeq = Math.max(0, Math.trunc(input.sinceSeq ?? 0));
    const expectedMethod = input.method?.toUpperCase();
    const matches: SearchBodyMatch[] = [];
    const requestMetadata = new Map<string, { url?: string; method?: string; status?: number }>();
    const bodyCandidates: TraceEvent[] = [];
    let totalScanned = 0;
    let hasMore = false;

    for await (const event of this.iterateEvents("network")) {
      const requestId = stringField(event, "requestId");
      if (requestId) {
        const current = requestMetadata.get(requestId) ?? {};
        requestMetadata.set(requestId, {
          url: stringField(event, "url") ?? stringField(event, "documentURL") ?? current.url,
          method: stringField(event, "method") ?? current.method,
          status: numberField(event, "status") ?? numberField(event, "statusCode") ?? current.status
        });
      }

      if (event.seq > sinceSeq && isBodyRef(event.bodyRef)) {
        bodyCandidates.push(event);
      }
    }

    for (const event of bodyCandidates) {
      const bodyRef = event.bodyRef;
      if (!isBodyRef(bodyRef)) {
        continue;
      }
      const requestId = stringField(event, "requestId");
      const metadata = requestId ? requestMetadata.get(requestId) : undefined;
      const url = stringField(event, "url") ?? metadata?.url;
      const method = stringField(event, "method") ?? metadata?.method;
      const status = numberField(event, "status") ?? numberField(event, "statusCode") ?? metadata?.status;

      if (input.urlContains && !(url ?? "").includes(input.urlContains)) {
        continue;
      }
      if (expectedMethod && method?.toUpperCase() !== expectedMethod) {
        continue;
      }
      if (input.status !== undefined && status !== input.status) {
        continue;
      }

      totalScanned += 1;
      const absolutePath = this.safeTracePath(bodyRef.path);
      if (!absolutePath) {
        continue;
      }
      const body = await readFile(absolutePath).catch(() => undefined);
      if (!body) {
        continue;
      }
      const snippet = matchSnippet(body.toString("utf8"), input.text);
      if (!snippet) {
        continue;
      }
      if (matches.length >= limit) {
        hasMore = true;
        break;
      }
      matches.push({
        seq: event.seq,
        type: event.type,
        t: event.t,
        wallTime: event.wallTime,
        pageUrl: event.pageUrl,
        requestId,
        url,
        method,
        status,
        bodyRef,
        snippet
      });
    }

    return { matches, totalScanned, hasMore };
  }

  async exportZip(targetPath?: string): Promise<string> {
    await this.flush();
    const zipPath = targetPath ?? `${this.outputDir}.rawtrace.zip`;
    const zipFile = new yazl.ZipFile();
    const output = createWriteStream(zipPath);
    const done = new Promise<void>((resolveDone, rejectDone) => {
      output.on("close", resolveDone);
      output.on("error", rejectDone);
      zipFile.outputStream.on("error", rejectDone);
    });

    zipFile.outputStream.pipe(output);
    await addDirectoryToZip(zipFile, this.outputDir, this.outputDir, basename(this.outputDir));
    zipFile.end();
    await done;
    return zipPath;
  }

  async *iterateEvents(stream: EventStream | "all"): AsyncGenerator<TraceEvent> {
    await this.flush();
    if (stream === "all") {
      for await (const event of this.iterateMergedEvents()) {
        yield event;
      }
      return;
    }

    for await (const event of readStreamEvents(this.streamPath(stream))) {
      yield event;
    }
  }

  manifest(): TraceManifest {
    return {
      traceSchemaVersion: TRACE_SCHEMA_VERSION,
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      stoppedAt: this.stoppedAt,
      status: this.stoppedAt ? "stopped" : "running",
      captureOptions: this.captureOptions,
      eventCounts: { ...this.eventCounts },
      streams: [...EVENT_STREAMS],
      outputDir: this.outputDir
    };
  }

  private async writeManifest(status: TraceManifest["status"]): Promise<TraceManifest> {
    const manifest = {
      ...this.manifest(),
      status
    };
    await writeFile(join(this.outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  private streamPath(stream: EventStream): string {
    return join(this.outputDir, `${stream}.ndjson`);
  }

  private writer(stream: EventStream): NdjsonStreamWriter {
    const writer = this.writers.get(stream);
    if (!writer) {
      throw new RawTraceError("TRACE_STREAM_NOT_OPEN", `Trace stream is not open: ${stream}`);
    }
    return writer;
  }

  private async preparePayload(source: EventStream, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (source !== "dom") {
      return payload;
    }
    return this.externalizeDomPayload(payload);
  }

  private async externalizeDomPayload(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const next = { ...payload };
    next.addedNodes = await this.externalizeNodeArray(next.addedNodes);
    next.removedNodes = await this.externalizeNodeArray(next.removedNodes);

    if (typeof next.outerHTML === "string") {
      await this.externalizeStringField(next, "outerHTML", "htmlRef", DOM_INLINE_HTML_LIMIT, "html");
    }
    if (typeof next.text === "string") {
      await this.externalizeStringField(next, "text", "textRef", DOM_INLINE_TEXT_LIMIT, "text");
    }
    if (typeof next.textValue === "string") {
      await this.externalizeStringField(next, "textValue", "textRef", DOM_INLINE_TEXT_LIMIT, "text");
    }

    return next;
  }

  private async externalizeNodeArray(value: unknown): Promise<unknown> {
    if (!Array.isArray(value)) {
      return value;
    }
    return Promise.all(value.map((node) => this.externalizeNodeSummary(node)));
  }

  private async externalizeNodeSummary(value: unknown): Promise<unknown> {
    if (!isRecord(value)) {
      return value;
    }
    const node = { ...value };
    if (typeof node.outerHTML === "string") {
      await this.externalizeStringField(node, "outerHTML", "htmlRef", DOM_INLINE_HTML_LIMIT, "html");
    }
    if (typeof node.text === "string") {
      await this.externalizeStringField(node, "text", "textRef", DOM_INLINE_TEXT_LIMIT, "text");
    }
    return node;
  }

  private async externalizeStringField(
    target: Record<string, unknown>,
    field: string,
    refField: string,
    inlineLimit: number,
    artifactKind: "html" | "text"
  ): Promise<void> {
    const value = target[field];
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") <= inlineLimit) {
      return;
    }
    target[refField] = await this.writeDomArtifact(artifactKind, value);
    delete target[field];
  }

  private async readSingleStreamEvents(stream: EventStream, offset: number, limit: number): Promise<{ events: TraceEvent[]; total: number }> {
    const events: TraceEvent[] = [];
    let total = 0;

    for await (const event of readStreamEvents(this.streamPath(stream))) {
      if (total >= offset && events.length < limit) {
        events.push(event);
      }
      total += 1;
    }

    return { events, total };
  }

  private async readMergedEvents(offset: number, limit: number): Promise<{ events: TraceEvent[]; total: number }> {
    const events: TraceEvent[] = [];
    let total = 0;

    for await (const event of this.iterateMergedEvents()) {
      if (total >= offset && events.length < limit) {
        events.push(event);
      }
      total += 1;
    }

    return { events, total };
  }

  private async *iterateMergedEvents(): AsyncGenerator<TraceEvent> {
    const cursors: Array<{ iterator: AsyncGenerator<TraceEvent>; current: TraceEvent }> = [];

    for (const stream of EVENT_STREAMS) {
      const iterator = readStreamEvents(this.streamPath(stream));
      const first = await iterator.next();
      if (!first.done) {
        cursors.push({ iterator, current: first.value });
      }
    }

    try {
      while (cursors.length > 0) {
        let nextIndex = 0;
        for (let index = 1; index < cursors.length; index += 1) {
          if (cursors[index]!.current.seq < cursors[nextIndex]!.current.seq) {
            nextIndex = index;
          }
        }

        const cursor = cursors[nextIndex]!;
        yield cursor.current;

        const next = await cursor.iterator.next();
        if (next.done) {
          cursors.splice(nextIndex, 1);
        } else {
          cursor.current = next.value;
        }
      }
    } finally {
      await Promise.all(cursors.map((cursor) => cursor.iterator.return(undefined)));
    }
  }

  private currentPageUrl(): string {
    try {
      return this.pageUrlProvider?.() ?? "";
    } catch {
      return "";
    }
  }

  private async eventMatchesSearch(event: TraceEvent, input: SearchEventsInput): Promise<{ matched: boolean; snippet?: string }> {
    if (input.type && event.type !== input.type) {
      return { matched: false };
    }
    if (input.urlContains && !eventUrlFields(event).some((value) => value.includes(input.urlContains ?? ""))) {
      return { matched: false };
    }
    if (!input.text) {
      return { matched: true };
    }

    const snippet = await this.searchTextSnippet(event, input.text);
    return snippet ? { matched: true, snippet } : { matched: false };
  }

  private async searchTextSnippet(event: TraceEvent, text: string): Promise<string | undefined> {
    const serialized = JSON.stringify(event);
    const inlineSnippet = matchSnippet(serialized, text);
    if (inlineSnippet) {
      return inlineSnippet;
    }

    if (event.source !== "dom") {
      return undefined;
    }

    for (const ref of collectDomArtifactRefs(event)) {
      const absolutePath = this.safeTracePath(ref.path);
      if (!absolutePath) {
        continue;
      }
      const artifact = await readFile(absolutePath, "utf8").catch(() => undefined);
      if (!artifact) {
        continue;
      }
      const artifactSnippet = matchSnippet(artifact, text);
      if (artifactSnippet) {
        return `[${ref.path}] ${artifactSnippet}`;
      }
    }

    return undefined;
  }

  private safeTracePath(relativePath: string): string | undefined {
    const absolutePath = resolve(this.outputDir, relativePath);
    const relativeToTrace = relative(this.outputDir, absolutePath);
    if (relativeToTrace.startsWith("..") || isAbsolute(relativeToTrace)) {
      return undefined;
    }
    return absolutePath;
  }
}

async function addDirectoryToZip(zipFile: yazl.ZipFile, baseRoot: string, currentRoot: string, zipRoot: string): Promise<void> {
  const entries = await readdir(currentRoot);
  for (const entry of entries) {
    const absolutePath = join(currentRoot, entry);
    const entryStat = await stat(absolutePath);
    if (entryStat.isDirectory()) {
      await addDirectoryToZip(zipFile, baseRoot, absolutePath, zipRoot);
      continue;
    }

    const metadataPath = join(zipRoot, relative(baseRoot, absolutePath)).replaceAll("\\", "/");
    zipFile.addFile(absolutePath, metadataPath);
  }
}

class NdjsonStreamWriter {
  private readonly stream;
  private readonly openPromise: Promise<void>;
  private pending: Promise<void> = Promise.resolve();
  private isClosed = false;

  constructor(private readonly path: string) {
    this.stream = createWriteStream(this.path, { flags: "w", encoding: "utf8" });
    this.openPromise = new Promise((resolveOpen, rejectOpen) => {
      this.stream.once("open", () => resolveOpen());
      this.stream.once("error", rejectOpen);
    });
  }

  async ready(): Promise<void> {
    await this.openPromise;
  }

  async write(line: string): Promise<void> {
    if (this.isClosed) {
      throw new RawTraceError("TRACE_STREAM_CLOSED", `Trace stream is already closed: ${this.path}`);
    }

    const operation = this.pending
      .then(() => this.openPromise)
      .then(
        () =>
          new Promise<void>((resolveWrite, rejectWrite) => {
            this.stream.write(line, "utf8", (error?: Error | null) => {
              if (error) {
                rejectWrite(error);
                return;
              }
              resolveWrite();
            });
          })
      );
    this.pending = operation.catch(() => undefined);
    await operation;
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    await this.flush();
    await new Promise<void>((resolveClose, rejectClose) => {
      const cleanup = () => {
        this.stream.off("error", onError);
      };
      const onError = (error: Error) => {
        cleanup();
        rejectClose(error);
      };
      this.stream.once("error", onError);
      this.stream.end(() => {
        cleanup();
        resolveClose();
      });
    });
    this.isClosed = true;
  }
}

async function* readStreamEvents(streamPath: string): AsyncGenerator<TraceEvent> {
  const lines = createInterface({
    input: createReadStream(streamPath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  try {
    for await (const line of lines) {
      if (line.trim().length > 0) {
        yield JSON.parse(line) as TraceEvent;
      }
    }
  } finally {
    lines.close();
  }
}

function normalizeLimit(limit: number, max: number, toolName: "monitor_read_events" | "monitor_search_events" | "monitor_search_bodies"): number {
  const safeLimit = Math.trunc(limit);
  if (!Number.isFinite(limit) || safeLimit < 1) {
    throw new RawTraceError("INVALID_LIMIT", `${toolName} limit must be a positive integer.`);
  }
  if (safeLimit > max) {
    const suggestion =
      toolName === "monitor_read_events"
        ? "use offset/limit pagination or monitor_search_events"
        : toolName === "monitor_search_bodies"
          ? "use narrower filters or sinceSeq pagination"
          : "use narrower filters or sinceSeq pagination";
    throw new RawTraceError(
      "LIMIT_TOO_LARGE",
      `${toolName} limit must be <= ${max}; ${suggestion}.`,
      { maxLimit: max, requestedLimit: safeLimit }
    );
  }
  return safeLimit;
}

function eventUrlFields(event: TraceEvent): string[] {
  return [event.pageUrl, stringField(event, "url"), stringField(event, "documentURL")].filter((value): value is string => Boolean(value));
}

function toSearchMatch(event: TraceEvent, snippet?: string): SearchEventMatch {
  return {
    seq: event.seq,
    source: event.source,
    type: event.type,
    t: event.t,
    wallTime: event.wallTime,
    pageUrl: event.pageUrl,
    preview: eventPreview(event),
    snippet
  };
}

function eventPreview(event: TraceEvent): Record<string, unknown> {
  const preview: Record<string, unknown> = {};
  for (const key of [
    "requestId",
    "url",
    "documentURL",
    "method",
    "status",
    "statusText",
    "resourceType",
    "targetPath",
    "attributeName",
    "value",
    "checked",
    "text",
    "textValue",
    "level",
    "message",
    "errorMessage",
    "bodyRef",
    "htmlRef",
    "textRef"
  ]) {
    const value = event[key];
    if (value !== undefined) {
      preview[key] = typeof value === "string" ? truncate(value, 300) : value;
    }
  }

  if (Array.isArray(event.addedNodes)) {
    preview.addedNodesCount = event.addedNodes.length;
    preview.firstAddedNode = compactNodeSummary(event.addedNodes[0]);
  }
  if (Array.isArray(event.removedNodes)) {
    preview.removedNodesCount = event.removedNodes.length;
    preview.firstRemovedNode = compactNodeSummary(event.removedNodes[0]);
  }
  return preview;
}

function compactNodeSummary(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return {
    nodeType: value.nodeType,
    tagName: value.tagName,
    path: value.path,
    text: typeof value.text === "string" ? truncate(value.text, 160) : undefined,
    htmlRef: value.htmlRef,
    textRef: value.textRef
  };
}

function matchSnippet(value: string, text: string): string | undefined {
  const index = value.toLowerCase().indexOf(text.toLowerCase());
  if (index < 0) {
    return undefined;
  }
  return truncate(value.slice(Math.max(0, index - 120), index + text.length + 180), 360);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function stringField(event: TraceEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(event: TraceEvent, key: string): number | undefined {
  const value = event[key];
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectDomArtifactRefs(value: unknown, refs: BodyRef[] = []): BodyRef[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectDomArtifactRefs(item, refs);
    }
    return refs;
  }
  if (!isRecord(value)) {
    return refs;
  }

  for (const key of ["htmlRef", "textRef"]) {
    const ref = value[key];
    if (isBodyRef(ref)) {
      refs.push(ref);
    }
  }

  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) {
      collectDomArtifactRefs(child, refs);
    }
  }

  return refs;
}

function isBodyRef(value: unknown): value is BodyRef {
  return isRecord(value) && typeof value.path === "string" && typeof value.byteLength === "number" && typeof value.sha256 === "string";
}

const COMMON_EVENT_FIELDS = new Set(["sessionId", "seq", "source", "type", "timeOrigin", "t", "wallTime", "pageUrl"]);

function protectCommonEventFields(payload: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  const payloadReservedFields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (COMMON_EVENT_FIELDS.has(key)) {
      payloadReservedFields[key] = value;
    } else {
      clean[key] = value;
    }
  }

  if (Object.keys(payloadReservedFields).length > 0) {
    const existingReserved = clean.payloadReservedFields;
    clean.payloadReservedFields =
      existingReserved === undefined
        ? payloadReservedFields
        : {
            existingPayloadReservedFields: existingReserved,
            ...payloadReservedFields
          };
  }

  return clean;
}

function makeSessionId(): string {
  const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const suffix = randomBytes(4).toString("hex");
  return `trace_${timestamp}_${suffix}`;
}

function roundMillis(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sanitizeFileStem(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return clean.length > 0 ? clean : "artifact";
}

function sanitizeFileExtension(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
  return clean.length > 0 ? clean : "bin";
}

export async function loadTraceSessionFromDirectory(outputDir: string): Promise<TraceManifest> {
  const manifestPath = resolve(outputDir, "manifest.json");
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as TraceManifest;
  } catch (error) {
    throw new RawTraceError("TRACE_MANIFEST_READ_FAILED", `Unable to read trace manifest at ${manifestPath}`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}
