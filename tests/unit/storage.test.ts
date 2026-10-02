import { mkdtemp, readFile, appendFile, writeFile, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { TraceStore, TraceReader, listTraces } from '../../src/storage/store.js';
import { defaults } from '../../src/types.js';
import { DomState, reconstruct } from '../../src/storage/state.js';

const tree = () => ({ type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'body', attributes: {}, childNodes: [
  { type: 2, id: 3, tagName: 'input', attributes: { value: 'initial', title: 'remove' } },
  { type: 3, id: 4, textContent: 'before' }
] }] });
async function setup(limits?: { segmentBytes?: number; queueBytes?: number }) {
  const root = await mkdtemp(join(tmpdir(), 'rawtrace-v2-'));
  const store = await TraceStore.create(root, { targets: [{ targetId: 'p', contextId: 'c', url: 'https://example.test', title: 'fixture' }], options: defaults }, limits);
  return { root, store };
}
describe('trace v2 persistence', () => {
  it('rotates segments, deduplicates content, restores without the index and ignores an incomplete tail', async () => {
    const { root, store } = await setup({ segmentBytes: 500 });
    const a = await store.artifact(Buffer.from('same')); const b = await store.artifact(Buffer.from('same'));
    expect(a).toEqual(b);
    for (let i = 0; i < 12; i++) await store.append({ source: 'console', type: 'log', data: { i } });
    await store.finish();
    expect((await readdir(join(store.directory, 'artifacts'))).length).toBe(1);
    const segments = (await readdir(join(store.directory, 'events'))).sort();
    expect(segments.length).toBeGreaterThan(1);
    await appendFile(join(store.directory, 'events', segments.at(-1)!), '{"seq":');
    await writeFile(join(store.directory, 'index.json'), 'invalid cache');
    const reader = await TraceReader.open(root, store.manifest.sessionId);
    expect(reader.index.lastSeq).toBe(12); expect(reader.recoveryGaps).toHaveLength(1);
    expect((await reader.query({ afterSeq: 3, limit: 2 })).events.map(e => e.seq)).toEqual([4, 5]);
    expect(await reader.readArtifact(a)).toEqual(Buffer.from('same'));
  });
  it('reconstructs historical DOM and cookie state and uses checkpoints', async () => {
    const { root, store } = await setup();
    await store.append({ source: 'cookies', type: 'baseline', contextId: 'c', data: { cookies: [{ name: 'a', domain: 'x', path: '/', value: '1' }] } });
    await store.append({ source: 'dom', type: 'baseline', pageId: 'p', documentId: 'd', data: { node: tree() } });
    await store.append({ source: 'dom', type: 'delta', pageId: 'p', documentId: 'd', data: { source: 0, texts: [{ id: 4, value: 'after' }], attributes: [{ id: 3, attributes: { title: null } }] } });
    await store.append({ source: 'dom', type: 'delta', pageId: 'p', documentId: 'd', data: { source: 5, id: 3, text: 'changed', isChecked: true } });
    await store.finish();
    const reader = await TraceReader.open(root, store.manifest.sessionId);
    expect((await reconstruct(reader, { pageId: 'p', atSeq: 2, format: 'text' })).text).toBe('before');
    const state = await reconstruct(reader, { pageId: 'p' });
    expect(state.tree.childNodes[0].childNodes[0].state.value).toBe('changed');
    expect(state.tree.childNodes[0].childNodes[0].attributes.title).toBeUndefined();
    expect(state.cookies[0].value).toBe('1'); expect(state.complete).toBe(true);
  });
  it('keeps raw payload out of the event log and makes body searching explicit', async () => {
    const { root, store } = await setup();
    const body = await store.artifact(Buffer.from('body-secret-needle'));
    await store.append({ source: 'network', type: 'finished', data: { body, url: 'https://example.test' } });
    await store.append({ source: 'dom', type: 'baseline', pageId: 'p', data: { node: tree() } });
    await store.finish();
    const reader = await TraceReader.open(root, store.manifest.sessionId);
    expect((await reader.query({ text: 'body-secret-needle' })).events).toHaveLength(0);
    expect((await reader.query({ text: 'body-secret-needle', searchBodies: true })).events).toHaveLength(1);
    const log = await readFile(join(store.directory, 'events', '00000001.ndjson'), 'utf8');
    expect(log).not.toContain('initial');
  });
  it('refuses path traversal, symlink escape, corrupted artifacts and legacy reconstruction', async () => {
    const { root, store } = await setup();
    const ref = await store.artifact(Buffer.from('secret')); await store.finish();
    const reader = await TraceReader.open(root, store.manifest.sessionId);
    await expect(reader.readArtifact({ ...ref, path: '../outside' })).rejects.toThrow();
    await expect(reader.readArtifact({ ...ref, sha256: '0'.repeat(64) })).rejects.toThrow('integrity');
    const outside = await mkdtemp(join(tmpdir(), 'rawtrace-outside-'));
    await symlink(outside, join(store.directory, 'outside'), 'junction');
    const { inside } = await import('../../src/storage/files.js');
    await expect(inside(store.directory, 'outside')).rejects.toThrow('outside');
    await mkdir(join(root, 'trace_legacy'));
    await writeFile(join(root, 'trace_legacy', 'manifest.json'), JSON.stringify({ traceSchemaVersion: '1.0.0' }));
    expect((await listTraces(root)).some(x => x.legacy)).toBe(true);
    await expect(TraceReader.open(root, 'trace_legacy')).rejects.toThrow('v1');
  });
  it('bounds queued data and records a failed session rather than silently dropping events', async () => {
    const { store } = await setup({ queueBytes: 100 });
    await expect(store.append({ source: 'console', type: 'log', data: { text: 'x'.repeat(500) } })).rejects.toThrow('budget');
    await store.finish(); expect(store.manifest.status).toBe('failed'); expect(store.manifest.gapCount).toBeGreaterThan(0);
  });
  it('reports a failed writer and preserves recoverable metadata', async () => {
    const { root, store } = await setup();
    await mkdir(join(store.directory, 'events', '00000001.ndjson'));
    await expect(store.append({ source: 'console', type: 'log', data: {} })).rejects.toThrow();
    await store.finish();
    const manifest = JSON.parse(await readFile(join(root, store.manifest.sessionId, 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('failed'); expect(manifest.gapCount).toBeGreaterThan(0);
  });
  it('uses source clock offsets for time queries and never treats timestamps as sequence order', async () => {
    const { root, store } = await setup();
    await store.append({ source: 'dom', type: 'baseline', pageId: 'p', documentId: 'd', sourceTime: 100, clock: { kind: 'test', offsetMs: 1000 }, data: { node: tree() } });
    await store.append({ source: 'dom', type: 'delta', pageId: 'p', documentId: 'd', sourceTime: 300, clock: { kind: 'test', offsetMs: 1000 }, data: { source: 0, texts: [{ id: 4, value: 'later' }] } });
    await store.append({ source: 'console', type: 'log', sourceTime: 200, clock: { kind: 'test', offsetMs: 1000 }, data: {} });
    await store.finish();
    const reader = await TraceReader.open(root, store.manifest.sessionId);
    expect((await reader.query({ toTime: 1250 })).events.map(e => e.seq)).toEqual([1, 3]);
    expect((await reconstruct(reader, { pageId: 'p', atTime: 1250, format: 'text' })).text).toBe('before');
  });
  it('handles moves and out-of-order sibling additions without running scripts', () => {
    const state = new DomState(); state.reset(tree());
    state.apply({ source: 0, removes: [{ parentId: 2, id: 4 }], adds: [
      { parentId: 2, nextId: 6, node: { id: 4, type: 3, textContent: 'moved' } },
      { parentId: 2, nextId: null, node: { id: 6, type: 3, textContent: 'tail' } }
    ] });
    expect(state.text()).toBe('movedtail'); expect(state.gaps).toHaveLength(0);
    state.apply({ source: 0, attributes: [{ id: 3, attributes: { style: 'color: red; background: url("data:image/svg+xml;a;b");' } }] });
    state.apply({ source: 0, attributes: [{ id: 3, attributes: { style: { color: ['blue', 'important'], width: '2px' } } }] });
    const style = state.root!.childNodes![0]!.childNodes![0]!.attributes!.style;
    expect(style).toContain('color: blue !important;'); expect(style).toContain('data:image/svg+xml;a;b');
  });
  it('keeps writer indexing bounded across sustained changes and checkpoint rotation', async () => {
    const { store, root } = await setup({ segmentBytes: 4096 });
    try {
      for (let i = 0; i < 6000; i++) {
        await store.append({ source: 'dom', type: i % 10 === 0 ? 'checkpoint' : 'delta', pageId: 'p', documentId: 'd',
          data: i % 10 === 0 ? { node: tree() } : { source: 0, texts: [{ id: 4, value: `change-${i}` }] } });
        expect(store.pendingBytes).toBeLessThan(4096);
      }
      await store.finish();
      const index = JSON.parse(await readFile(join(store.directory, 'index.json'), 'utf8'));
      expect(index.checkpoints.length).toBeLessThanOrEqual(512);
      expect(index.segments.length).toBeLessThanOrEqual(128);
      const reader = await TraceReader.open(root, store.manifest.sessionId);
      expect(reader.index.lastSeq).toBe(6000);
      expect((await reconstruct(reader, { pageId: 'p', format: 'text' })).text).toBe('change-5999');
    } finally { await store.finish(); }
  }, 30_000);
});
