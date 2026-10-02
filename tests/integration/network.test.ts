import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { it, expect } from 'vitest';
import { CaptureService } from '../../src/capture/service.js';

it('preserves redirects, binary bodies, body failures, duplicate WebSocket messages, console and cookie deltas', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/binary' }); res.end(); }
    else if (req.url === '/binary') { res.setHeader('content-type', 'application/octet-stream'); res.end(Buffer.from([0, 255, 3, 8])); }
    else if (req.url === '/large') { res.end('x'.repeat(100_000)); }
    else { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><p>network fixture</p>'); }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => { ws.send('repeat-message'); ws.send('repeat-message'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
  const port = (listener.address() as any).port; await new Promise<void>(r => listener.close(() => r()));
  const root = await mkdtemp(join(tmpdir(), 'rawtrace-network-'));
  const context = await chromium.launchPersistentContext(join(root, 'profile'), { headless: true, args: [`--remote-debugging-port=${port}`] });
  const service = new CaptureService(join(root, 'traces'));
  try {
    const page = context.pages()[0]!; await page.goto(url);
    const targets = await service.targets(`http://127.0.0.1:${port}`);
    await service.start({ cdpUrl: `http://127.0.0.1:${port}`, targetIds: [targets[0]!.targetId], acknowledgeRawCapture: true, maxBodyBytes: 1000 });
    await page.evaluate(async () => {
      await fetch('/redirect').then(r => r.arrayBuffer()); await fetch('/binary').then(r => r.arrayBuffer());
      await fetch('/large').then(r => r.text());
      console.error('synthetic-console-error'); document.cookie = 'changed=raw-cookie';
      await new Promise<void>(resolve => { const ws = new WebSocket(location.origin.replace('http', 'ws')); let n = 0;
        ws.onmessage = () => { if (++n === 2) { ws.close(); resolve(); } }; });
    });
    await new Promise(r => setTimeout(r, 1200));
    await page.evaluate(() => { document.cookie = 'changed=;max-age=0'; });
    await service.stop();
    const reader = await service.reader(service.status().sessionId);
    const all = []; for await (const event of reader.events()) all.push({ ...event, data: await reader.data(event) });
    expect(all.some(e => e.type === 'request' && e.data.hop === 1)).toBe(true);
    const binaries = all.filter(e => e.type === 'finished' && e.data.url?.endsWith('/binary'));
    expect(binaries.length).toBe(2); expect(binaries[0]!.data.body).toEqual(binaries[1]!.data.body);
    expect(await reader.readArtifact(binaries[0]!.data.body)).toEqual(Buffer.from([0, 255, 3, 8]));
    expect(all.some(e => e.type === 'finished' && e.data.url?.endsWith('/large') && e.data.body.skipped)).toBe(true);
    const messages = all.filter(e => e.type === 'webSocketFrameReceived');
    expect(messages).toHaveLength(2); expect(messages[0]!.data.response.payload).toEqual(messages[1]!.data.response.payload);
    expect(all.some(e => e.source === 'console' && e.data.text === 'synthetic-console-error')).toBe(true);
    expect(all.some(e => e.source === 'cookies' && e.data.upsert?.length)).toBe(true);
    expect(all.some(e => e.source === 'cookies' && e.data.removed?.length)).toBe(true);
  } finally { await service.stop().catch(() => undefined); await context.close(); wss.close(); await new Promise<void>(r => server.close(() => r())); }
}, 30_000);
