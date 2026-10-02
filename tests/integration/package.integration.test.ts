import { execFile } from 'node:child_process';
import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { it, expect } from 'vitest';
import { RAWTRACE_SERVER_INSTRUCTIONS } from '../../src/server/mcpServer.js';

const exec = promisify(execFile);
it('ships a runnable nine-tool plugin with consistent source versions and published marketplace pins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rawtrace-package-v2-'));
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this packaging test through npm test or npm run test:integration.');
  const { stdout } = await exec(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory]);
  const [pack] = JSON.parse(stdout);
  const names = new Set(pack.files.map((file: { path: string }) => file.path));
  for (const name of ['dist/cli.js', 'dist/browser-recorder.js', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.mcp.json',
    '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', 'skills/rawtrace-debug-browser/SKILL.md', 'README.en.md', 'examples/browser.mjs'])
    expect(names.has(name), name).toBe(true);
  expect([...names].some(name => String(name).startsWith('rawtrace-traces/'))).toBe(false);
  await exec('tar', ['-xzf', join(directory, pack.filename), '-C', directory]);
  const root = join(directory, 'package');
  // Use lockfile-verified local dependencies without another network installation.
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'junction');
  const read = async (path: string) => JSON.parse(await readFile(join(root, path), 'utf8'));
  const pkg = await read('package.json');
  for (const path of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) expect((await read(path)).version).toBe(pkg.version);
  for (const path of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'])
    expect((await read(path)).plugins[0].source.version).toBe('0.3.0');
  const config = (await read('.mcp.json')).mcpServers.rawtrace;
  const args = config.args.map((value: string) => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', root));
  expect(args).toHaveLength(1);
  const client = new Client({ name: 'package-validation', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: config.command, args }));
    expect(client.getInstructions()).toBe(RAWTRACE_SERVER_INSTRUCTIONS);
    expect((await client.listTools()).tools).toHaveLength(9);
  } finally { await client.close(); }
}, 30_000);
