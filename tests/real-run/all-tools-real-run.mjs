import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openExampleBrowser } from '../../examples/browser.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Sidecar real run</title><p id="value">initial</p><button onclick="document.querySelector(\'#value\').textContent=\'changed\'">Change</button>'); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const portServer = createServer(); await new Promise(r => portServer.listen(0, '127.0.0.1', r));
const port = portServer.address().port; await new Promise(r => portServer.close(r));
const root = await mkdtemp(join(tmpdir(), 'rawtrace-real-v2-'));
const { context } = await openExampleBrowser({ port, headless: true, url });
const client = new Client({ name: 'rawtrace-real-run', version: '0.4.0' });
const called = new Set();
const call = async (name, args = {}) => {
  called.add(name);
  const result = await client.callTool({ name, arguments: { acknowledgeRawCapture: true, ...args } });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed)); return parsed.result;
};
try {
  const page = context.pages()[0]; await page.goto(url);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', '--output-root', join(root, 'traces')] }));
  const targets = await call('capture_targets', { cdpUrl: `http://127.0.0.1:${port}` });
  const target = targets.find(t => t.url.startsWith(url));
  const started = await call('capture_start', { cdpUrl: `http://127.0.0.1:${port}`, targetIds: [target.targetId] });
  const sessionId = started.sessionId;
  await page.click('button'); await new Promise(r => setTimeout(r, 150));
  assert.equal((await call('capture_status')).active, true);
  await call('capture_stop');
  const traces = await call('trace_list'); assert(traces.some(t => t.sessionId === sessionId));
  const info = await call('trace_info', { sessionId }); assert(info.checkpoints.length);
  const events = await call('trace_events', { sessionId, source: 'dom' });
  const baseline = events.events.find(e => e.type === 'baseline');
  const artifact = await call('trace_artifact', { sessionId, ref: baseline.data.artifact });
  assert(artifact.content.includes('initial'));
  const state = await call('trace_state', { sessionId, pageId: target.targetId, format: 'text' });
  assert(state.text.includes('changed'));
  assert.equal(await page.title(), 'Sidecar real run');
  assert.equal(called.size, 9);
  console.log(JSON.stringify({ ok: true, tools: [...called], traceRoot: join(root, 'traces') }, null, 2));
} finally {
  await client.close(); await context.close(); await new Promise(r => server.close(r));
}
