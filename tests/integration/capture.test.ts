import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { describe, it, expect } from 'vitest';
import { CaptureService } from '../../src/capture/service.js';
import { reconstruct } from '../../src/storage/state.js';
import { startDemoServer } from '../fixtures/demoServer.js';

export async function externalBrowser() {
  const port = await new Promise<number>(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = (server.address() as any).port; server.close(() => resolve(port)); }); });
  const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'rawtrace-browser-')), { headless: true, args: [`--remote-debugging-port=${port}`] });
  return { context, endpoint: `http://127.0.0.1:${port}` };
}
async function sleep(ms: number) { await new Promise(r => setTimeout(r, ms)); }
describe('sidecar capture', () => {
  it('records externally controlled pages, reconstructs DOM, captures network and cookies, survives navigation and does not close browser', async () => {
    const demo = await startDemoServer(); const { context, endpoint } = await externalBrowser();
    const root = await mkdtemp(join(tmpdir(), 'rawtrace-capture-'));
    const service = new CaptureService(root, { checkpointMs: 1000, checkpointEvents: 5000, maxQueueBytes: 8 * 1024 * 1024 });
    try {
      const page = context.pages()[0]!; await page.goto(demo.url);
      const other = await context.newPage(); await other.goto(`${demo.url}/second`);
      const targets = await service.targets(endpoint); const target = targets.find(t => t.url === `${demo.url}/`)!;
      expect(target).toBeDefined();
      await service.start({ cdpUrl: endpoint, targetIds: [target.targetId], acknowledgeRawCapture: true });
      const sessionId = service.status().sessionId;
      await page.fill('#query', 'delta-value'); await page.click('#submit');
      await page.evaluate(() => {
        const root = document.createElement('div'); root.id = 'shadow-host'; document.body.append(root);
        root.attachShadow({ mode: 'open' }).innerHTML = '<span>shadow-message</span>';
        const n = document.createElement('div'); n.id = 'delta-node'; n.textContent = 'delta-final'; document.body.append(n);
      });
      await other.evaluate(() => { document.body.textContent = 'unselected-secret'; });
      await sleep(1400);
      let reader = await service.reader(sessionId);
      let state = await reconstruct(reader, { pageId: target.targetId, format: 'text' });
      expect(state.text).toContain('delta-final'); expect(state.text).toContain('shadow-message');
      expect(state.complete, JSON.stringify(state.gaps)).toBe(true);
      expect(state.text).not.toContain('unselected-secret');
      expect(state.cookies.some((c: any) => c.name === 'rawtrace_demo')).toBe(true);
      expect((await reader.query({ source: 'network', urlContains: '/api/search' })).events.length).toBeGreaterThan(0);
      expect((await reader.query({ source: 'websocket' })).events.length).toBeGreaterThan(0);
      expect(reader.index.checkpoints.length).toBeGreaterThan(1);
      const beforeNavigation = reader.index.lastSeq;
      await page.goto(`${demo.url}/second`); await sleep(150);
      await service.stop();
      expect(await page.title()).toBe('RawTrace Second Page');
      reader = await new CaptureService(root).reader(sessionId);
      state = await reconstruct(reader, { pageId: target.targetId, format: 'text' });
      expect(state.text).toContain('Second Page');
      expect((await reconstruct(reader, { pageId: target.targetId, atSeq: beforeNavigation, format: 'text' })).text).toContain('delta-final');
      expect(reader.manifest.status).toBe('stopped');
    } finally { await service.stop().catch(() => undefined); await context.close(); await demo.close(); }
  }, 40_000);
  it('requires acknowledgment and does not create a browser on bad targets', async () => {
    const service = new CaptureService();
    await expect(service.start({ cdpUrl: 'http://127.0.0.1:1', targetIds: ['x'] })).rejects.toThrow('acknowledge');
  });
  it('does not write idle checkpoints, marks abrupt browser loss, and allows historical queries', async () => {
    const { context, endpoint } = await externalBrowser();
    const root = await mkdtemp(join(tmpdir(), 'rawtrace-disconnect-'));
    const service = new CaptureService(root, { checkpointMs: 500, checkpointEvents: 5000, maxQueueBytes: 8 * 1024 * 1024 });
    try {
      const page = context.pages()[0]!; await page.setContent('<p>idle-baseline</p>');
      const targets = await service.targets(endpoint);
      await service.start({ cdpUrl: endpoint, targetIds: [targets[0]!.targetId], acknowledgeRawCapture: true });
      const sessionId = service.status().sessionId;
      await sleep(1200);
      expect((await service.reader(sessionId)).index.checkpoints).toHaveLength(1);
      await context.close();
      for (let i = 0; i < 40 && service.status().active; i++) await sleep(50);
      expect(service.status().active).toBe(false);
      expect((await service.reader(sessionId)).manifest.status).toBe('interrupted');
    } finally { await service.stop().catch(() => undefined); await context.close(); }
  }, 20_000);
});
