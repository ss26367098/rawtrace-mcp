import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { join } from 'node:path';
import { CaptureService, acknowledge } from '../capture/service.js';
import { asRawTraceError } from '../errors.js';
import { reconstruct } from '../storage/state.js';
import { atomic, digest } from '../storage/files.js';

const ack = z.object({ acknowledgeRawCapture: z.boolean().optional() });
const session = ack.extend({ sessionId: z.string().min(1) });
const ref = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative() });
export function createRawTraceMcpServer(service = new CaptureService()): McpServer {
  const server = new McpServer({ name: 'rawtrace-mcp', version: '0.3.0' });
  const register = <T extends z.ZodType>(name: string, description: string, schema: T, handler: (input: z.output<T>) => Promise<any>): void => {
    const add = server.registerTool.bind(server) as any;
    add(name, { description, inputSchema: schema }, async (raw: unknown) => {
      try {
        const input = schema.parse(raw);
        let result = await handler(input);
        const bytes = Buffer.from(JSON.stringify(result));
        if (bytes.length > 64_000 && typeof (input as any).sessionId === 'string') {
          const reader = await service.reader((input as any).sessionId);
          const sha256 = digest(bytes); const path = `artifacts/${sha256}`;
          await atomic(join(reader.directory, path), bytes);
          result = { artifact: { path, sha256, byteLength: bytes.length }, contentEncoding: 'json' };
        }
        const value = { ok: true, result };
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      } catch (error) {
        const normalized = asRawTraceError(error);
        const value = { ok: false, error: { code: normalized.code, message: normalized.message } };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      }
    });
  };
  register('capture_targets', 'Discover pages in an existing Chromium CDP browser; does not launch or operate it.', ack.extend({ cdpUrl: z.string().url() }), async input => {
    acknowledge(input); return service.targets(input.cdpUrl);
  });
  register('capture_start', 'Continuously record selected existing pages and their frames; raw data is not masked.', ack.extend({
    cdpUrl: z.string().url(), targetIds: z.array(z.string().min(1)).min(1),
    captureDom: z.boolean().optional(), captureNetwork: z.boolean().optional(), captureWebSockets: z.boolean().optional(),
    captureCookies: z.boolean().optional(), captureConsole: z.boolean().optional(), captureFrames: z.boolean().optional(),
    maxBodyBytes: z.number().int().positive().max(100_000_000).optional()
  }), input => service.start(input));
  register('capture_status', 'Get recording status, queue size and integrity counters.', ack, async input => { acknowledge(input); return service.status(); });
  register('capture_stop', 'Flush recording and disconnect without closing the external browser.', z.object({}), () => service.stop());
  register('trace_list', 'Discover persisted v2 and legacy v1 traces under the configured output root.', ack, async input => { acknowledge(input); return service.list(); });
  register('trace_info', 'Read trace metadata and derived checkpoint index; legacy v1 is not reconstructed.', session, async input => {
    acknowledge(input); const reader = await service.reader(input.sessionId);
    return { manifest: reader.manifest, checkpoints: reader.index.checkpoints, gaps: reader.recoveryGaps };
  });
  register('trace_events', 'Query recorded events by sequence, time, source, page, node or text; body text search is opt-in.', session.extend({
    afterSeq: z.number().int().nonnegative().optional(), untilSeq: z.number().int().nonnegative().optional(),
    fromTime: z.number().optional(), toTime: z.number().optional(),
    source: z.enum(['dom', 'network', 'websocket', 'cookies', 'console', 'frames', 'system']).optional(),
    type: z.string().optional(), pageId: z.string().optional(), documentId: z.string().optional(), nodeId: z.number().int().optional(),
    urlContains: z.string().optional(), text: z.string().optional(), searchBodies: z.boolean().optional(), limit: z.number().int().min(1).max(1000).optional()
  }), async input => { acknowledge(input); return (await service.reader(input.sessionId)).query(input); });
  register('trace_state', 'Reconstruct recorded DOM and form state plus context cookies without executing scripts or loading resources.', session.extend({
    pageId: z.string(), atSeq: z.number().int().nonnegative().optional(), atTime: z.number().optional(), format: z.enum(['tree', 'text']).optional()
  }).refine(input => input.atSeq === undefined || input.atTime === undefined, 'Specify atSeq or atTime, not both.'), async input => {
    acknowledge(input); return reconstruct(await service.reader(input.sessionId), input);
  });
  register('trace_artifact', 'Read a bounded byte range of an integrity-checked trace artifact.', session.extend({
    ref, offset: z.number().int().nonnegative().default(0), maxBytes: z.number().int().min(1).max(32_000).default(32_000),
    encoding: z.enum(['utf8', 'base64']).default('utf8')
  }), async input => {
    acknowledge(input); const bytes = await (await service.reader(input.sessionId)).readArtifact(input.ref);
    // JSON escaping can expand a UTF-8 control byte sixfold; keep every artifact
    // read bounded so clients never need to chase recursively wrapped results.
    const part = bytes.subarray(input.offset, input.offset + Math.min(input.maxBytes, input.encoding === 'utf8' ? 8000 : 32_000));
    return { ref: input.ref, offset: input.offset, nextOffset: input.offset + part.length,
      hasMore: input.offset + part.length < bytes.length, encoding: input.encoding, content: part.toString(input.encoding) };
  });
  server.server.onclose = () => { void service.stop('shutdown').catch(() => undefined); };
  return server;
}
