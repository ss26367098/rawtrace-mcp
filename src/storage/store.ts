import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { RawTraceError } from '../errors.js';
import type { ArtifactRef, EventInput, EventQuery, Manifest, TraceEvent } from '../types.js';
import { atomic, digest, inside, jsonFile } from './files.js';

interface Segment { path: string; firstSeq: number; lastSeq: number; bytes: number }
export interface Checkpoint { seq: number; time: number; pageId?: string; documentId?: string; segment: string }
interface Index { segments: Segment[]; checkpoints: Checkpoint[]; lastSeq: number }
const emptyIndex = (): Index => ({ segments: [], checkpoints: [], lastSeq: 0 });

export class TraceStore {
  readonly directory: string;
  private queue: Promise<void> = Promise.resolve();
  private failure?: Error;
  private accepting = true;
  private index = emptyIndex();
  private queueBytes = 0;
  private sinceIndex = 0;
  private segmentNumber = 0;
  private indexTimer?: NodeJS.Timeout;
  private finalizePromise?: Promise<void>;
  onFailure?: (error: Error) => void;
  constructor(readonly root: string, readonly manifest: Manifest,
    private readonly segmentBytes = 64 * 1024 * 1024,
    private readonly maxQueueBytes = 32 * 1024 * 1024) {
    this.directory = resolve(root, manifest.sessionId);
  }
  static async create(root: string, init: Pick<Manifest, 'targets' | 'options'>,
    limits?: { segmentBytes?: number; queueBytes?: number }): Promise<TraceStore> {
    const sessionId = `trace_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const store = new TraceStore(root, {
      traceSchemaVersion: '2.0.0', sessionId, createdAt: Date.now(), status: 'running',
      ...init, eventCount: 0, bytes: 0, counts: {}, gapCount: 0,
      cookieScope: 'Entire shared contexts of selected pages; not page-local.',
      cookieIntervalMs: 1000, recorderVersion: '@rrweb/record@2.1.6'
    }, limits?.segmentBytes, limits?.queueBytes);
    await mkdir(join(store.directory, 'events'), { recursive: true });
    await mkdir(join(store.directory, 'artifacts'), { recursive: true });
    await store.saveMetadata();
    store.indexTimer = setInterval(() => { void store.checkpointIndex().catch(() => undefined); }, 5000);
    store.indexTimer.unref();
    return store;
  }
  get pendingBytes(): number { return this.queueBytes; }
  get error(): Error | undefined { return this.failure; }
  abort(reason: string): void {
    this.accepting = false;
    this.failure ??= new RawTraceError('CAPTURE_ABORTED', reason);
    this.manifest.status = 'failed'; this.manifest.reason = reason;
    this.manifest.stoppedAt = Date.now(); this.manifest.gapCount++;
    clearInterval(this.indexTimer);
    // Best effort only: an unavailable disk must not defeat the stop deadline.
    void atomic(join(this.directory, 'manifest.json'), JSON.stringify(this.manifest)).catch(() => undefined);
  }
  private fail(error: unknown): Error {
    const value = error instanceof Error ? error : new Error(String(error));
    if (!this.failure) { this.failure = value; this.accepting = false; this.onFailure?.(value); }
    return value;
  }
  append(input: EventInput): Promise<TraceEvent> {
    if (!this.accepting) return Promise.reject(this.failure ?? new RawTraceError('TRACE_CLOSED', 'Trace is closed.'));
    const receivedAt = Date.now();
    // Serialize at admission, so a producer cannot mutate data while it is queued.
    const serialized = JSON.stringify(input);
    const size = Buffer.byteLength(serialized);
    if (this.queueBytes + size > this.maxQueueBytes) {
      return Promise.reject(this.fail(new RawTraceError('QUEUE_OVERFLOW', 'Writer queue exceeded its memory budget.')));
    }
    this.queueBytes += size;
    const operation = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      const entry = JSON.parse(serialized) as EventInput;
      if (Buffer.byteLength(JSON.stringify(entry.data)) > 32_000 || entry.type === 'baseline' || entry.type === 'checkpoint') {
        entry.data = { artifact: await this.artifact(Buffer.from(JSON.stringify(entry.data))) };
      }
      const event: TraceEvent = { ...entry, sessionId: this.manifest.sessionId,
        seq: this.manifest.eventCount + 1, receivedAt,
        time: (entry.sourceTime ?? receivedAt) + (entry.clock?.offsetMs ?? 0) };
      const line = JSON.stringify(event) + '\n';
      const bytes = Buffer.byteLength(line);
      let segment = this.index.segments.at(-1);
      if (!segment || (segment.bytes > 0 && segment.bytes + bytes > this.segmentBytes)) {
        segment = { path: `events/${String(++this.segmentNumber).padStart(8, '0')}.ndjson`,
          firstSeq: event.seq, lastSeq: event.seq, bytes: 0 };
        this.index.segments.push(segment);
        if (this.index.segments.length > 128) this.index.segments.shift();
      }
      await appendFile(join(this.directory, segment.path), line);
      segment.bytes += bytes; segment.lastSeq = event.seq;
      this.manifest.bytes += bytes; this.manifest.eventCount = event.seq;
      this.manifest.counts[event.source] = (this.manifest.counts[event.source] ?? 0) + 1;
      if (event.type === 'gap') this.manifest.gapCount++;
      this.index.lastSeq = event.seq;
      if (event.source === 'dom' && ['baseline', 'checkpoint'].includes(event.type)) {
        this.index.checkpoints.push({ seq: event.seq, time: event.time, pageId: event.pageId,
          documentId: event.documentId, segment: segment.path });
        if (this.index.checkpoints.length > 512) this.index.checkpoints.shift();
      }
      if (++this.sinceIndex >= 1000) { await this.saveMetadata(); this.sinceIndex = 0; }
      return event;
    });
    this.queue = operation.then(() => undefined, error => { this.fail(error); }).finally(() => { this.queueBytes -= size; });
    return operation;
  }
  async artifact(bytes: Buffer): Promise<ArtifactRef> {
    const hash = digest(bytes); const path = `artifacts/${hash}`;
    const absolute = join(this.directory, path);
    if (!(await stat(absolute).catch(() => undefined))) {
      await atomic(absolute, bytes);
      this.manifest.bytes += bytes.byteLength;
    }
    return { path, sha256: hash, byteLength: bytes.byteLength };
  }
  async flush(): Promise<void> { await this.queue; if (this.failure) throw this.failure; }
  private async saveMetadata(): Promise<void> {
    await atomic(join(this.directory, 'index.json'), JSON.stringify(this.index));
    await atomic(join(this.directory, 'manifest.json'), JSON.stringify(this.manifest, null, 2));
  }
  private checkpointIndex(): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    const task = this.queue.then(() => this.saveMetadata());
    this.queue = task.catch(error => { this.fail(error); });
    return task;
  }
  finish(reason = 'manual'): Promise<void> {
    this.finalizePromise ??= this.finishOnce(reason);
    return this.finalizePromise;
  }
  private async finishOnce(reason: string): Promise<void> {
    this.accepting = false; clearInterval(this.indexTimer);
    await this.queue;
    this.manifest.stoppedAt = Date.now();
    this.manifest.status = this.failure ? 'failed' : reason === 'manual' ? 'stopped' : 'interrupted';
    this.manifest.reason = this.failure?.message ?? reason;
    if (this.failure || !['manual', 'shutdown'].includes(reason)) this.manifest.gapCount++;
    await this.saveMetadata();
  }
}

export class TraceReader {
  private constructor(readonly directory: string, readonly manifest: Manifest, readonly index: Index,
    readonly recoveryGaps: string[]) {}
  static async open(root: string, sessionId: string, active = false): Promise<TraceReader> {
    if (!/^trace_[\w.-]+$/.test(sessionId)) throw new RawTraceError('INVALID_SESSION_ID', 'Invalid session ID.');
    const directory = await inside(root, sessionId);
    const manifest = await jsonFile<Manifest>(directory, 'manifest.json');
    if (manifest.traceSchemaVersion !== '2.0.0') throw new RawTraceError('UNSUPPORTED_TRACE_VERSION', 'Use RawTrace 0.2.x to read trace v1; no automatic conversion is performed.');
    const index = emptyIndex(); const gaps: string[] = [];
    const counts: Manifest['counts'] = {}; let gapCount = 0;
    const eventsDir = await inside(directory, 'events');
    const names = (await readdir(eventsDir)).filter(x => /^\d{8}\.ndjson$/.test(x)).sort();
    let last = 0;
    for (const name of names) {
      const path = `events/${name}`; const absolute = await inside(directory, path);
      const segment: Segment = { path, firstSeq: last + 1, lastSeq: last, bytes: (await stat(absolute)).size };
      for await (const event of eventLines(absolute, () => gaps.push(`Incomplete tail in ${path}`))) {
        if (event.seq !== last + 1) throw new RawTraceError('TRACE_CORRUPT', `Unexpected event sequence ${event.seq} after ${last}.`);
        last = event.seq; segment.lastSeq = last;
        counts[event.source] = (counts[event.source] ?? 0) + 1;
        if (event.type === 'gap') gapCount++;
        if (event.source === 'dom' && ['baseline', 'checkpoint'].includes(event.type))
          index.checkpoints.push({ seq: last, time: event.time, pageId: event.pageId, documentId: event.documentId, segment: path });
      }
      index.segments.push(segment);
    }
    index.lastSeq = last;
    if (manifest.status === 'running' && !active) { manifest.status = 'interrupted'; manifest.reason = 'process_ended_without_finalization'; gaps.push(manifest.reason); }
    manifest.eventCount = last;
    manifest.counts = counts; manifest.gapCount = Math.max(manifest.gapCount, gapCount) + gaps.length;
    // Index is derived, never trusted over the log (including after a crash).
    return new TraceReader(directory, manifest, index, gaps);
  }
  async *events(afterSeq = 0, untilSeq = this.index.lastSeq): AsyncGenerator<TraceEvent> {
    for (const segment of this.index.segments) {
      if (segment.lastSeq <= afterSeq || segment.firstSeq > untilSeq) continue;
      for await (const event of eventLines(await inside(this.directory, segment.path))) {
        if (event.seq > untilSeq) return;
        if (event.seq > afterSeq) yield event;
      }
    }
  }
  async readArtifact(ref: ArtifactRef): Promise<Buffer> {
    if (!/^artifacts\/[a-f0-9]{64}$/.test(ref.path)) throw new RawTraceError('INVALID_ARTIFACT', 'Only content-addressed artifacts can be read.');
    const bytes = await readFile(await inside(this.directory, ref.path));
    if (digest(bytes) !== ref.sha256 || bytes.length !== ref.byteLength) throw new RawTraceError('ARTIFACT_HASH_MISMATCH', 'Artifact integrity check failed.');
    return bytes;
  }
  async data(event: TraceEvent): Promise<any> {
    return event.data?.artifact ? JSON.parse((await this.readArtifact(event.data.artifact)).toString('utf8')) : event.data;
  }
  async query(query: EventQuery): Promise<{ events: TraceEvent[]; nextAfterSeq: number; hasMore: boolean }> {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RawTraceError('INVALID_LIMIT', 'limit must be 1..1000.');
    const result: TraceEvent[] = []; let next = query.afterSeq ?? 0;
    for await (const event of this.events(query.afterSeq, query.untilSeq)) {
      if (query.source && event.source !== query.source || query.type && event.type !== query.type ||
        query.pageId && event.pageId !== query.pageId || query.documentId && event.documentId !== query.documentId ||
        query.fromTime !== undefined && event.time < query.fromTime || query.toTime !== undefined && event.time > query.toTime) continue;
      const data = await this.data(event);
      if (query.nodeId !== undefined && !hasNode(data, query.nodeId)) continue;
      const text = JSON.stringify(data);
      if (query.urlContains && !text.includes(query.urlContains)) continue;
      if (query.text && !text.toLowerCase().includes(query.text.toLowerCase())) {
        let matched = false;
        if (query.searchBodies && event.source === 'network') {
          for (const ref of refs(data)) if ((await this.readArtifact(ref)).toString('utf8').toLowerCase().includes(query.text.toLowerCase())) { matched = true; break; }
        }
        if (!matched) continue;
      }
      if (result.length === limit) return { events: result, nextAfterSeq: next, hasMore: true };
      result.push(event); next = event.seq;
    }
    return { events: result, nextAfterSeq: this.index.lastSeq, hasMore: false };
  }
}
export async function listTraces(root: string): Promise<any[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const result: any[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('trace_')) continue;
    try {
      const directory = await inside(root, entry.name);
      const manifest = await jsonFile<any>(directory, 'manifest.json');
      result.push({ sessionId: entry.name, traceSchemaVersion: manifest.traceSchemaVersion,
        legacy: manifest.traceSchemaVersion !== '2.0.0', status: manifest.status, createdAt: manifest.createdAt });
    } catch { result.push({ sessionId: entry.name, status: 'unreadable' }); }
  }
  return result;
}
async function* eventLines(path: string, onTail?: () => void): AsyncGenerator<TraceEvent> {
  let pending = ''; const stream = createReadStream(path, { encoding: 'utf8' });
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line) yield JSON.parse(line) as TraceEvent;
      }
    }
    if (pending) onTail?.();
  } finally { stream.destroy(); }
}
function hasNode(value: any, id: number): boolean {
  if (!value || typeof value !== 'object') return false;
  if (value.id === id || value.nodeId === id || value.parentId === id) return true;
  return Object.values(value).some(child => hasNode(child, id));
}
function* refs(value: any): Generator<ArtifactRef> {
  if (!value || typeof value !== 'object') return;
  if (typeof value.path === 'string' && typeof value.sha256 === 'string') { yield value; return; }
  for (const child of Object.values(value)) yield* refs(child);
}
