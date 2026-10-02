import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { it, expect } from 'vitest';
import { CaptureService } from '../../src/capture/service.js';
import { reconstruct } from '../../src/storage/state.js';

it('captures same/cross-origin frames, repeated frame navigation, multiple explicit targets and checkpoints', async () => {
  const web = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/frame' ? '<p id="v">frame-initial</p>' : '<p>parent-page</p><iframe src="/frame"></iframe>');
  });
  await new Promise<void>(r => web.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(web.address() as any).port}`;
  const listener = createServer(); await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
  const port = (listener.address() as any).port; await new Promise<void>(r => listener.close(() => r()));
  const root = await mkdtemp(join(tmpdir(), 'rawtrace-frames-'));
  const context = await chromium.launchPersistentContext(join(root, 'profile'), { headless: true, args: [`--remote-debugging-port=${port}`] });
  const service = new CaptureService(join(root, 'traces'), { checkpointMs: 700, checkpointEvents: 5000, maxQueueBytes: 8 * 1024 * 1024 });
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    const page = context.pages()[0]!; await page.goto(url);
    const second = await context.newPage(); await second.goto(`${url}/frame`);
    const targets = await service.targets(`http://127.0.0.1:${port}`);
    await service.start({ cdpUrl: `http://127.0.0.1:${port}`, targetIds: targets.map(t => t.targetId), acknowledgeRawCapture: true });
    const pageId = targets.find(t => t.url === `${url}/`)!.targetId;
    const sessionId = service.status().sessionId;
    await page.frameLocator('iframe').locator('#v').evaluate(el => { el.textContent = 'same-origin-changed'; });
    await second.locator('#v').evaluate(el => { el.textContent = 'second-target'; });
    await pause(150);
    expect((await reconstruct(await service.reader(sessionId), { pageId, format: 'text' })).text).toContain('same-origin-changed');
    const crossNavigation = page.waitForEvent('framenavigated', f => f.url().includes('localhost'));
    await page.locator('iframe').evaluate((el, src) => { (el as HTMLIFrameElement).src = src; }, `${url.replace('127.0.0.1', 'localhost')}/frame`);
    await crossNavigation;
    await page.frameLocator('iframe').locator('#v').waitFor();
    await page.frameLocator('iframe').locator('#v').evaluate(el => { el.textContent = 'cross-origin-changed'; });
    await pause(1100);
    let state = await reconstruct(await service.reader(sessionId), { pageId, format: 'text' });
    expect(state.text).toContain('cross-origin-changed');
    expect(state.text).not.toContain('same-origin-changed');
    const sameNavigation = page.waitForEvent('framenavigated', f => f !== page.mainFrame() && f.url().includes('127.0.0.1'));
    await page.locator('iframe').evaluate(el => { (el as HTMLIFrameElement).src = '/frame'; });
    await sameNavigation;
    await page.frameLocator('iframe').locator('#v').waitFor(); await pause(200);
    await service.stop();
    state = await reconstruct(await service.reader(sessionId), { pageId, format: 'text' });
    expect(state.text).toContain('frame-initial'); expect(state.text).not.toContain('cross-origin-changed');
  } finally { await service.stop().catch(() => undefined); await context.close(); await new Promise<void>(r => web.close(() => r())); }
}, 30_000);
