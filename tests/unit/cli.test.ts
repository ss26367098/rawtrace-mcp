import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../src/cli.js';

describe('capture CLI', () => {
  it('defaults to stdio and a persistent output root', () => {
    expect(parseCliArgs(['node', 'rawtrace-mcp'])).toMatchObject({ transport: 'stdio', outputRoot: 'rawtrace-traces' });
  });
  it('accepts an explicit output root and HTTP endpoint', () => {
    expect(parseCliArgs(['node', 'rawtrace-mcp', '--output-root', 'saved-traces', '--transport', 'http', '--port', '3758']))
      .toMatchObject({ outputRoot: 'saved-traces', transport: 'http', port: 3758 });
  });
  it('rejects unsupported transports and invalid ports', () => {
    expect(() => parseCliArgs(['node', 'rawtrace-mcp', '--transport', 'sse'])).toThrow('Unsupported transport');
    expect(() => parseCliArgs(['node', 'rawtrace-mcp', '--port', '70000'])).toThrow('Invalid port');
  });
});
