import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { it, expect } from 'vitest';
import { createRawTraceMcpServer } from '../../src/server/mcpServer.js';
import { startHttpMcpServer } from '../../src/server/http.js';

it('exposes only nine capture/query tools on stdio', async () => {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js'] }));
  try {
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(9); expect(tools.every(t => /^(capture|trace)_/.test(t.name))).toBe(true);
    expect((await client.callTool({ name: 'capture_start', arguments: { cdpUrl: 'http://localhost:1', targetIds: ['x'] } })).isError).toBe(true);
  } finally { await client.close(); }
});
it('serves the same tools over HTTP', async () => {
  const server = createRawTraceMcpServer(); const http = await startHttpMcpServer(server, { host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
    expect((await client.listTools()).tools).toHaveLength(9);
    expect((await client.callTool({ name: 'capture_status', arguments: { acknowledgeRawCapture: true } })).isError).not.toBe(true);
  } finally { await client.close(); await http.close(); await server.close(); }
});
