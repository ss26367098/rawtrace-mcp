import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, BrowserContext, CDPSession, Frame } from 'playwright';
import { RawTraceError } from '../errors.js';
import { defaults, type CaptureOptions, type EventInput, type Target } from '../types.js';
import { TraceStore, TraceReader, listTraces } from '../storage/store.js';
import { cookieKey } from '../storage/state.js';
import { connect, type ConnectedTarget } from './connection.js';

type Dispose = () => void | Promise<void>;
interface Active {
  browser: Browser; store: TraceStore; targets: ConnectedTarget[]; dispose: Dispose[];
  pending: Set<Promise<unknown>>; cookiePolls: Array<() => Promise<void>>; stopping: boolean;
  stopPromise?: Promise<any>;
  connections: CDPSession[];
}
export interface StartInput extends Partial<CaptureOptions> {
  cdpUrl: string; targetIds: string[]; acknowledgeRawCapture?: boolean;
}
export class CaptureService {
  private active?: Active;
  private starting = false;
  private last?: TraceStore;
  constructor(readonly outputRoot = resolve('rawtrace-traces'),
    private readonly browserConfig = { checkpointMs: 60_000, checkpointEvents: 5000, maxQueueBytes: 8 * 1024 * 1024 }) {}
  async targets(cdpUrl: string): Promise<Target[]> {
    const connection = await connect(cdpUrl);
    try { return connection.targets.map(publicTarget); }
    finally { await connection.browser.close(); }
  }
  async start(input: StartInput): Promise<any> {
    acknowledge(input);
    if (this.active || this.starting) throw new RawTraceError('CAPTURE_ACTIVE', 'Only one active capture is allowed.');
    if (!input.targetIds.length) throw new RawTraceError('TARGET_REQUIRED', 'Select at least one target.');
    this.starting = true;
    let browser: Browser | undefined;
    try {
      const connection = await connect(input.cdpUrl); browser = connection.browser;
      const selected = [...new Set(input.targetIds)].map(id => {
        const target = connection.targets.find(t => t.targetId === id);
        if (!target) throw new RawTraceError('TARGET_NOT_FOUND', `Target no longer exists: ${id}`);
        return target;
      });
      const options = { ...defaults };
      for (const key of Object.keys(defaults) as Array<keyof CaptureOptions>) if (input[key] !== undefined) Object.assign(options, { [key]: input[key] });
      const store = await TraceStore.create(this.outputRoot, { targets: selected.map(publicTarget), options });
      const active: Active = { browser, store, targets: selected, dispose: [], pending: new Set(), cookiePolls: [], stopping: false, connections: [] };
      this.active = active; this.last = store;
      store.onFailure = () => { if (!active.stopping) void this.stop('writer_failure').catch(() => undefined); };
      const disconnected = (): void => { if (!active.stopping) void this.stop('browser_disconnected').catch(() => undefined); };
      browser.on('disconnected', disconnected); active.dispose.push(() => { browser?.off('disconnected', disconnected); });
      for (const target of selected) await this.attachPage(active, target);
      if (options.captureCookies) {
        const contexts = new Map<BrowserContext, string>();
        for (const target of selected) contexts.set(target.page.context(), target.contextId);
        for (const [context, contextId] of contexts) await this.attachCookies(active, context, contextId);
      }
      await store.flush();
      return this.status();
    } catch (error) {
      if (this.active) await this.stop('start_failed').catch(() => undefined);
      else await browser?.close().catch(() => undefined);
      throw error;
    } finally { this.starting = false; }
  }
  status(): any {
    const store = this.active?.store ?? this.last;
    return store ? { ...store.manifest, active: Boolean(this.active), stopping: this.active?.stopping ?? false,
      pendingBytes: store.pendingBytes, pendingOperations: this.active?.pending.size ?? 0, error: store.error?.message }
      : { active: false };
  }
  private track(active: Active, task: Promise<unknown>): void {
    active.pending.add(task);
    if (active.pending.size > 256 && !active.stopping) void this.stop('collector_backpressure').catch(() => undefined);
    void task.catch(error => {
      if (!active.stopping) void this.gap(active, 'collector_error', { message: String(error) }).catch(() => undefined);
    }).finally(() => active.pending.delete(task));
  }
  private emit(active: Active, input: EventInput): void {
    this.track(active, active.store.append(input));
  }
  private gap(active: Active, reason: string, extra: any = {}): Promise<unknown> {
    return active.store.append({ source: 'system', type: 'gap', data: { reason, ...extra } });
  }
  private async attachCookies(active: Active, context: BrowserContext, contextId: string): Promise<void> {
    let previous = new Map((await context.cookies()).map(c => [cookieKey(c), c]));
    await active.store.append({ source: 'cookies', type: 'baseline', contextId, data: { cookies: [...previous.values()] } });
    let running: Promise<void> | undefined;
    const poll = (): Promise<void> => {
      if (running) return running;
      running = (async () => {
        const current = new Map((await context.cookies()).map(c => [cookieKey(c), c]));
        const removed = [...previous.keys()].filter(key => !current.has(key));
        const upsert = [...current.entries()].filter(([key, c]) => JSON.stringify(previous.get(key)) !== JSON.stringify(c)).map(([, c]) => c);
        if (removed.length || upsert.length) await active.store.append({ source: 'cookies', type: 'delta', contextId,
          sourceTime: Date.now(), clock: { kind: 'node_cookie_poll', offsetMs: 0, uncertaintyMs: 1000 }, data: { removed, upsert } });
        previous = current;
      })().finally(() => { running = undefined; });
      return running;
    };
    const timer = setInterval(() => { if (!active.stopping) this.track(active, poll()); }, 1000);
    active.dispose.push(() => clearInterval(timer)); active.cookiePolls.push(poll);
  }
  private async attachPage(active: Active, target: ConnectedTarget): Promise<void> {
    const { page, targetId: pageId, contextId } = target;
    const frameIds = new Map<Frame, string>();
    const frameId = (frame: Frame): string => {
      let id = frameIds.get(frame); if (!id) { id = randomUUID(); frameIds.set(frame, id); } return id;
    };
    const documents = new Map<Frame, string>();
    const options = active.store.manifest.options;
    const calibrationStart = Date.now();
    const browserEpoch = await page.evaluate(() => performance.timeOrigin + performance.now());
    const calibrationEnd = Date.now();
    const clockOffset = (calibrationStart + calibrationEnd) / 2 - browserEpoch;
    const clockUncertainty = (calibrationEnd - calibrationStart) / 2 + 1;
    const key = `__rawtrace_${randomUUID().replaceAll('-', '')}`;
    const binding = `${key}_emit`;
    const sourceSeqs = new Map<string, number>();
    let domDocument: string | undefined;
    if (options.captureDom) {
      const bundle = await readFile(new URL('../browser-recorder.js', import.meta.url), 'utf8')
        .catch(() => readFile(new URL('../../dist/browser-recorder.js', import.meta.url), 'utf8'));
      const script = `(function(){${bundle}\nRawTraceRecorder.install(${JSON.stringify({ key, binding, ...this.browserConfig })});})();`;
      const bound = await page.exposeBinding(binding, async (source, batch: any[]) => {
        if (!Array.isArray(batch)) return;
        for (const item of batch) {
          if (typeof item.documentId !== 'string' || !Number.isInteger(item.sourceSeq)) continue;
          const previous = sourceSeqs.get(item.documentId) ?? 0;
          if (item.sourceSeq <= previous) continue;
          if (item.sourceSeq !== previous + 1) {
            await active.store.append({ source: 'system', type: 'gap', pageId, documentId: item.documentId,
              data: { reason: 'source_sequence_gap', previous, next: item.sourceSeq } });
            this.track(active, page.evaluate(k => { (window as any)[k]?.checkpoint(); }, key));
          }
          // Only retain sequence state for the current document of this page.
          if (domDocument !== item.documentId) { sourceSeqs.clear(); domDocument = item.documentId; }
          sourceSeqs.set(item.documentId, item.sourceSeq);
          await active.store.append({ source: 'dom', type: item.type, pageId, contextId,
            frameId: frameId(source.frame), documentId: item.documentId, sourceSeq: item.sourceSeq,
            sourceTime: item.sourceTime, clock: { kind: 'browser_performance_epoch', offsetMs: clockOffset, uncertaintyMs: clockUncertainty }, data: item.data });
          if (item.type === 'gap' && item.data?.reason === 'snapshot_exceeds_browser_budget') {
            void this.stop('snapshot_exceeds_browser_budget').catch(() => undefined);
          }
        }
      });
      const initialized = await page.addInitScript({ content: script });
      // Dispose the initialization first during stop, after flushing existing frame recorders.
      active.dispose.push(() => initialized[Symbol.asyncDispose]());
      active.dispose.push(() => bound[Symbol.asyncDispose]());
      active.dispose.push(async () => {
        for (const frame of page.frames()) await frame.evaluate(async k => { await (window as any)[k]?.stop(); }, key).catch(() => undefined);
      });
      for (const frame of page.frames()) {
        await frame.evaluate(script).catch(error => this.gap(active, 'frame_injection_failed', { pageId, frameId: frameId(frame), url: frame.url(), message: String(error) }));
      }
    }
    const frameEvent = (type: string, frame: Frame): void => {
      if (type === 'navigated') documents.set(frame, randomUUID());
      if (options.captureFrames) this.emit(active, { source: 'frames', type, pageId, frameId: frameId(frame), documentId: documents.get(frame), contextId,
        data: { url: frame.url(), name: frame.name(), isMainFrame: frame === page.mainFrame(), parentFrameId: frame.parentFrame() ? frameId(frame.parentFrame()!) : undefined } });
      if (type === 'detached') { documents.delete(frame); frameIds.delete(frame); }
    };
    for (const frame of page.frames()) frameEvent('navigated', frame);
    const attached = (f: Frame): void => frameEvent('attached', f);
    const navigated = (f: Frame): void => {
      frameEvent('navigated', f);
      if (options.captureDom) this.track(active, f.evaluate(k => Boolean((window as any)[k]), key).then(installed => {
        if (!installed) return this.gap(active, 'frame_recorder_unavailable', { pageId, frameId: frameId(f), url: f.url() });
        return undefined;
      }).catch(error => this.gap(active, 'frame_recorder_unavailable', { pageId, url: f.url(), message: String(error) })));
    };
    const detached = (f: Frame): void => frameEvent('detached', f);
    page.on('frameattached', attached); page.on('framenavigated', navigated); page.on('framedetached', detached);
    active.dispose.push(() => { page.off('frameattached', attached); page.off('framenavigated', navigated); page.off('framedetached', detached); });
    const closed = (): void => {
      if (!active.stopping && active.targets.every(t => t.page.isClosed())) void this.stop('targets_closed').catch(() => undefined);
    };
    page.on('close', closed); active.dispose.push(() => { page.off('close', closed); });
    if (options.captureConsole) {
      const log = (message: any): void => this.emit(active, { source: 'console', type: 'log', pageId, contextId,
        data: { level: message.type(), text: message.text(), location: message.location() } });
      const error = (e: Error): void => this.emit(active, { source: 'console', type: 'error', pageId, contextId, data: { message: e.message, stack: e.stack } });
      page.on('console', log); page.on('pageerror', error);
      active.dispose.push(() => { page.off('console', log); page.off('pageerror', error); });
    }
    if (options.captureNetwork || options.captureWebSockets) {
      const cdp = await page.context().newCDPSession(page);
      await this.attachNetwork(active, target, cdp, clockOffset, clockUncertainty);
      // OOPIF network events require their own CDP target session.
      const frameConnections = new Map<Frame, Dispose>();
      const attachFrame = async (frame: Frame): Promise<void> => {
        if (frame === page.mainFrame() || active.stopping) return;
        await frameConnections.get(frame)?.(); frameConnections.delete(frame);
        let session: CDPSession | undefined;
        try {
          session = await page.context().newCDPSession(frame);
          const { targetInfo } = await session.send('Target.getTargetInfo');
          if (targetInfo.targetId === pageId) { await session.detach(); return; }
          frameConnections.set(frame, await this.attachNetwork(active, target, session, clockOffset, clockUncertainty));
        } catch (error) {
          await session?.detach().catch(() => undefined);
          // In-process frames are already covered by the page session.
          if (!String(error).includes('does not have a separate CDP session')) await this.gap(active, 'frame_network_unavailable', { pageId, url: frame.url(), message: String(error) });
        }
      };
      for (const frame of page.frames()) await attachFrame(frame);
      const onFrame = (frame: Frame): void => { this.track(active, attachFrame(frame)); };
      const onDetach = (frame: Frame): void => {
        const dispose = frameConnections.get(frame); frameConnections.delete(frame);
        if (dispose) this.track(active, Promise.resolve().then(dispose));
      };
      page.on('framenavigated', onFrame); page.on('framedetached', onDetach);
      active.dispose.push(() => { page.off('framenavigated', onFrame); page.off('framedetached', onDetach); frameConnections.clear(); });
    }
  }
  private async attachNetwork(active: Active, target: ConnectedTarget, cdp: CDPSession, clockOffset: number, clockUncertainty: number): Promise<Dispose> {
    active.connections.push(cdp);
    const options = active.store.manifest.options;
    const pending = new Map<string, { url: string; hop: number }>();
    const id = randomUUID(); let sourceSeq = 0, offsetMs: number | undefined;
    let processing: Promise<void> = Promise.resolve();
    const handlers: Array<[string, (params: any) => void]> = [];
    const on = (name: string, handler: (params: any, seq: number) => Promise<void>): void => {
      const callback = (params: any): void => {
        const seq = ++sourceSeq;
        const task = processing.then(() => handler(params, seq));
        processing = task.catch(() => undefined); this.track(active, task);
      };
      cdp.on(name as any, callback); handlers.push([name, callback]);
    };
    const event = (type: string, params: any, seq: number, data: any, source: 'network' | 'websocket' = 'network'): Promise<unknown> => active.store.append({
      source, type, pageId: target.targetId, contextId: target.contextId,
      frameId: params.frameId, documentId: params.loaderId, sourceSeq: seq,
      sourceTime: params.timestamp ? params.timestamp * 1000 : Date.now(),
      clock: { kind: params.timestamp ? 'cdp_monotonic' : 'node_received', offsetMs: params.timestamp ? offsetMs ?? Date.now() - params.timestamp * 1000 : 0,
        uncertaintyMs: offsetMs === undefined ? undefined : clockUncertainty },
      data: { connectionId: id, ...data }
    });
    if (options.captureNetwork) {
      on('Network.requestWillBeSent', async (params, seq) => {
        if (params.wallTime && params.timestamp) offsetMs = (params.wallTime - params.timestamp) * 1000 + clockOffset;
        const old = pending.get(params.requestId); const hop = old ? old.hop + 1 : 0;
        pending.set(params.requestId, { url: params.request.url, hop });
        if (pending.size > 4096 && !active.stopping) void this.stop('too_many_pending_requests').catch(() => undefined);
        const copy = structuredClone(params); const postData = copy.request.postData;
        delete copy.request.postData;
        if (copy.request.postDataEntries) {
          for (const entry of copy.request.postDataEntries) if (typeof entry.bytes === 'string') {
            const bytes = Buffer.from(entry.bytes, 'base64'); delete entry.bytes;
            entry.body = bytes.length > options.maxBodyBytes ? { skipped: 'maxBodyBytes', byteLength: bytes.length } : await active.store.artifact(bytes);
          }
        }
        if (typeof postData === 'string') {
          const bytes = Buffer.from(postData);
          copy.request.body = bytes.length > options.maxBodyBytes ? { skipped: 'maxBodyBytes', byteLength: bytes.length } : await active.store.artifact(bytes);
        }
        await event('request', params, seq, { ...copy, hop });
      });
      for (const name of ['requestWillBeSentExtraInfo', 'responseReceived', 'responseReceivedExtraInfo'])
        on(`Network.${name}`, async (params, seq) => { await event(name, params, seq, params); });
      on('Network.loadingFinished', async (params, seq) => {
        const request = pending.get(params.requestId); pending.delete(params.requestId);
        let body: any;
        try {
          const response = await cdp.send('Network.getResponseBody', { requestId: params.requestId });
          const bytes = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf8');
          body = bytes.length > options.maxBodyBytes ? { skipped: 'maxBodyBytes', byteLength: bytes.length } : await active.store.artifact(bytes);
        } catch (error) { body = { skipped: 'unavailable', message: String(error) }; }
        await event('finished', params, seq, { ...params, url: request?.url, hop: request?.hop, body });
      });
      on('Network.loadingFailed', async (params, seq) => { pending.delete(params.requestId); await event('failed', params, seq, params); });
    }
    if (options.captureWebSockets) for (const name of ['webSocketCreated', 'webSocketWillSendHandshakeRequest', 'webSocketHandshakeResponseReceived', 'webSocketFrameSent', 'webSocketFrameReceived', 'webSocketFrameError', 'webSocketClosed']) {
      on(`Network.${name}`, async (params, seq) => {
        const copy = structuredClone(params);
        if (typeof copy.response?.payloadData === 'string') {
          const payload = copy.response.payloadData; delete copy.response.payloadData;
          copy.response.payload = await active.store.artifact(Buffer.from(payload, copy.response.opcode === 2 ? 'base64' : 'utf8'));
        }
        await event(name, params, seq, copy, 'websocket');
      });
    }
    await cdp.send('Network.enable', { maxTotalBufferSize: Math.max(100_000_000, options.maxBodyBytes * 5), maxResourceBufferSize: options.maxBodyBytes });
    let disposal: Promise<void> | undefined;
    const dispose = (): Promise<void> => disposal ??= (async () => {
      for (const [name, handler] of handlers) cdp.off(name as any, handler);
      await processing;
      for (const [requestId, request] of pending) await active.store.append({ source: 'network', type: 'unfinished', pageId: target.targetId,
        data: { connectionId: id, requestId, ...request, reason: 'capture_stopped_before_completion' } });
      pending.clear();
      await cdp.detach().catch(() => undefined);
      active.connections = active.connections.filter(connection => connection !== cdp);
      active.dispose = active.dispose.filter(callback => callback !== dispose);
    })();
    active.dispose.push(dispose);
    return dispose;
  }
  async stop(reason = 'manual'): Promise<any> {
    const active = this.active;
    if (!active) return this.status();
    active.stopPromise ??= this.stopOnce(active, reason);
    return active.stopPromise;
  }
  private async stopOnce(active: Active, reason: string): Promise<any> {
    active.stopping = true;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (async () => {
      for (const poll of active.cookiePolls) await poll().catch(error => this.gap(active, 'final_cookie_poll_failed', { message: String(error) }).catch(() => undefined));
      for (const dispose of [...active.dispose].reverse()) await Promise.resolve().then(dispose).catch(error => this.gap(active, 'cleanup_failed', { message: String(error) }).catch(() => undefined));
      while (active.pending.size) await Promise.allSettled([...active.pending]);
      for (const connection of active.connections) await connection.detach().catch(() => undefined);
      await active.store.finish(reason);
      await active.browser.close();
    })();
    try {
      const timedOut = await Promise.race([cleanup.then(() => false), new Promise<boolean>(r => { timer = setTimeout(() => r(true), 10_000); })]);
      if (timedOut) {
        active.store.abort('stop_timeout');
        void active.browser.close().catch(() => undefined);
      }
    } finally {
      clearTimeout(timer);
      void active.browser.close().catch(() => undefined);
      this.active = undefined;
    }
    return this.status();
  }
  async reader(sessionId: string): Promise<TraceReader> {
    const active = this.active?.store.manifest.sessionId === sessionId;
    if (active) await this.active!.store.flush();
    return TraceReader.open(this.outputRoot, sessionId, active);
  }
  async list(): Promise<any[]> { return listTraces(this.outputRoot); }
}
export function acknowledge(input: { acknowledgeRawCapture?: boolean }): void {
  if (input.acknowledgeRawCapture !== true) throw new RawTraceError('RAW_CAPTURE_ACK_REQUIRED', 'acknowledgeRawCapture: true is required for raw browser data.');
}
function publicTarget(target: ConnectedTarget): Target {
  return { targetId: target.targetId, contextId: target.contextId, title: target.title, url: target.url };
}
