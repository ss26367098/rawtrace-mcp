import { record } from '@rrweb/record';

interface Config { key: string; binding: string; checkpointMs: number; checkpointEvents: number; maxQueueBytes: number }
export function install(config: Config): void {
  const host = window as unknown as Record<string, any>;
  if (host[config.key]) return;
  const documentId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let seq = 0, queuedBytes = 0, dirty = false, changes = 0, stopped = false;
  let viewport = { width: window.innerWidth, height: window.innerHeight };
  let lastSnapshot = performance.now(), sending = false, needsBaseline = false;
  let independentFrame = window === window.parent;
  if (!independentFrame) { try { void window.parent.document; } catch { independentFrame = true; } }
  const requestChildren = (): void => {
    for (let index = 0; index < window.frames.length; index++) window.frames[index]?.postMessage({ rawtraceCheckpoint: config.key }, '*');
  };
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== window.parent || event.data?.rawtraceCheckpoint !== config.key || stopped) return;
    if (independentFrame) record.takeFullSnapshot(true);
    else requestChildren();
  };
  window.addEventListener('message', onMessage);
  const queue: any[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const now = (): number => performance.timeOrigin + performance.now();
  const flush = async (): Promise<void> => {
    if (sending) return;
    sending = true;
    try {
      while (queue.length) {
        const batch = queue.splice(0, 100);
        queuedBytes -= batch.reduce((sum, item) => sum + item.size, 0);
        try { await host[config.binding](batch.map(item => item.value)); }
        catch { needsBaseline = true; queue.length = 0; queuedBytes = 0; break; }
      }
    } finally { sending = false; }
    if (needsBaseline && !stopped) {
      needsBaseline = false;
      enqueue('gap', { reason: 'browser_buffer_or_bridge_loss' });
      record.takeFullSnapshot(true);
    }
  };
  const enqueue = (type: string, data: any): void => {
    const value = { documentId, sourceSeq: ++seq, sourceTime: now(), url: location.href, type, data };
    const size = JSON.stringify(value).length * 2;
    if (size > config.maxQueueBytes || queuedBytes + size > config.maxQueueBytes) {
      // Do not pretend the chain is complete; the next accepted snapshot resets it.
      queue.length = 0; queuedBytes = 0; needsBaseline = true;
      if (type === 'baseline' || type === 'checkpoint') {
        const gap = { ...value, type: 'gap', data: { reason: 'snapshot_exceeds_browser_budget' } };
        queue.push({ value: gap, size: 512 }); queuedBytes = 512;
        stopped = true;
      }
    } else { queue.push({ value, size }); queuedBytes += size; }
    if (!timer) timer = setTimeout(() => { timer = undefined; void flush(); }, 25);
  };
  const stopRecord = record({
    recordCrossOriginIframes: true, recordCanvas: false, collectFonts: false,
    inlineImages: false, inlineStylesheet: false, slimDOMOptions: {},
    blockClass: /(?!) /, ignoreClass: `rawtrace-never-${documentId}`, maskTextClass: /(?!) /,
    maskInputOptions: { password: false }, maskAllInputs: false,
    maskInputFn: value => value, maskTextFn: value => value,
    sampling: { mousemove: false, mouseInteraction: false, input: 'all', scroll: 100 },
    emit(event: any, checkout?: boolean) {
      if (stopped) return;
      if (event.type === 2) {
        enqueue(checkout ? 'checkpoint' : 'baseline', { node: event.data.node, initialOffset: event.data.initialOffset, viewport, url: location.href });
        dirty = false; changes = 0; lastSnapshot = performance.now();
        // Parent snapshots cannot serialize cross-origin documents. Ask child
        // recorders to emit fresh documents into the new mirror after checkout.
        setTimeout(requestChildren, 0);
      } else if (event.type === 3) {
        if (![0, 3, 4, 5].includes(event.data.source)) return;
        if (event.data.source === 4) {
          if (event.data.width === viewport.width && event.data.height === viewport.height) return;
          viewport = { width: event.data.width, height: event.data.height };
        }
        enqueue('delta', event.data);
        if (!checkout) { dirty = true; changes++; }
      }
    },
    errorHandler(error) { enqueue('gap', { reason: 'recorder_error', message: String(error) }); return true; }
  });
  let href = location.href;
  const interval = setInterval(() => {
    if (stopped) return;
    if (href !== location.href) { href = location.href; enqueue('location', { url: href }); dirty = true; }
    if (dirty && (performance.now() - lastSnapshot >= config.checkpointMs || changes >= config.checkpointEvents)) record.takeFullSnapshot(true);
  }, 250);
  const unload = (): void => { void flush(); };
  window.addEventListener('pagehide', unload);
  host[config.key] = {
    async stop() {
      stopRecord?.(); stopped = true; clearInterval(interval); clearTimeout(timer);
      window.removeEventListener('pagehide', unload);
      window.removeEventListener('message', onMessage);
      while (sending) await new Promise(resolve => setTimeout(resolve, 5));
      await flush(); delete host[config.key];
    },
    checkpoint() { record.takeFullSnapshot(true); }
  };
}
