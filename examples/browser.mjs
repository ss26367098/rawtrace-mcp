import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';

// This is an example external controller, not part of the MCP recorder.
export async function openExampleBrowser({ url = 'about:blank', port = 9222, headless = false } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1..65535');
  const profile = await mkdtemp(join(tmpdir(), 'rawtrace-example-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless, args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1']
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(url);
    return { context, page, profile, cdpUrl: `http://127.0.0.1:${port}` };
  } catch (error) { await context.close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = new Command().argument('[url]', 'Authorized test site', 'about:blank')
    .option('--port <number>', 'Local CDP port', Number, 9222)
    .option('--headless', 'Run without a visible window', false).parse();
  const browser = await openExampleBrowser({ url: command.args[0], ...command.opts() });
  console.log(JSON.stringify({ cdpUrl: browser.cdpUrl, profile: browser.profile, url: browser.page.url() }, null, 2));
  console.log('Keep this terminal open. Ctrl+C closes this example browser. The temporary test profile is retained.');
  let closing = false;
  const close = () => { if (!closing) { closing = true; void browser.context.close().finally(() => process.exit(0)); } };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
