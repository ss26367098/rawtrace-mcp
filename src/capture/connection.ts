import { chromium, type Browser, type Page } from 'playwright';
import type { Target } from '../types.js';

export interface ConnectedTarget extends Target { page: Page }
export async function connect(endpoint: string): Promise<{ browser: Browser; targets: ConnectedTarget[] }> {
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  try {
    const targets: ConnectedTarget[] = [];
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const session = await context.newCDPSession(page);
        try {
          const { targetInfo } = await session.send('Target.getTargetInfo');
          targets.push({ targetId: targetInfo.targetId, contextId: targetInfo.browserContextId ?? 'default',
            title: targetInfo.title, url: targetInfo.url, page });
        } finally { await session.detach(); }
      }
    }
    return { browser, targets };
  } catch (error) { await browser.close(); throw error; }
}
