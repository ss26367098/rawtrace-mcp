import { RawTraceError } from '../errors.js';
import type { TraceReader } from './store.js';

export interface StateNode {
  id: number; type: number; tagName?: string; textContent?: string;
  attributes?: Record<string, any>; childNodes?: StateNode[]; isShadow?: boolean;
  state?: Record<string, any>; [key: string]: any;
}
/** A data-only reducer: never creates a browser DOM or executes captured code. */
export class DomState {
  root?: StateNode;
  private nodes = new Map<number, StateNode>();
  private parents = new Map<number, StateNode>();
  readonly gaps: string[] = [];
  viewport?: { width: number; height: number };
  reset(node: StateNode): void {
    this.root = structuredClone(node); this.nodes.clear(); this.parents.clear();
    this.index(this.root);
  }
  private index(node: StateNode, parent?: StateNode): void {
    this.nodes.set(node.id, node); if (parent) this.parents.set(node.id, parent);
    if (['input', 'textarea', 'select'].includes(node.tagName ?? '')) {
      node.state ??= {};
      if (node.attributes?.value !== undefined) node.state.value = node.attributes.value;
      if (node.attributes?.checked !== undefined) node.state.checked = Boolean(node.attributes.checked);
    }
    for (const child of node.childNodes ?? []) this.index(child, node);
  }
  private forget(node: StateNode): void {
    this.nodes.delete(node.id); this.parents.delete(node.id);
    for (const child of node.childNodes ?? []) this.forget(child);
  }
  apply(data: any): void {
    if (data.source === 0) {
      for (const removal of data.removes ?? []) {
        const parent = this.nodes.get(removal.parentId), node = this.nodes.get(removal.id);
        if (parent && node) { parent.childNodes = parent.childNodes?.filter(x => x.id !== node.id); this.forget(node); }
      }
      const pending = [...(data.adds ?? [])];
      while (pending.length) {
        let progress = false;
        for (let i = 0; i < pending.length;) {
          const add = pending[i], parent = this.nodes.get(add.parentId);
          if (!parent || add.nextId > 0 && !parent.childNodes?.some(x => x.id === add.nextId)) { i++; continue; }
          const node = structuredClone(add.node) as StateNode;
          const old = this.nodes.get(node.id);
          if (old) { const oldParent = this.parents.get(node.id); if (oldParent) oldParent.childNodes = oldParent.childNodes?.filter(x => x.id !== node.id); this.forget(old); }
          // An iframe receives a new Document on navigation; replace its old document.
          if (node.type === 0) for (const child of [...(parent.childNodes ?? [])]) {
            if (child.type === 0) { this.forget(child); parent.childNodes = parent.childNodes?.filter(x => x !== child); }
          }
          parent.childNodes ??= [];
          const next = parent.childNodes.findIndex(x => x.id === add.nextId);
          parent.childNodes.splice(next < 0 ? parent.childNodes.length : next, 0, node);
          this.index(node, parent); pending.splice(i, 1); progress = true;
        }
        if (!progress) { this.gaps.push(`Unresolved added nodes: ${pending.map(x => x.node.id).join(',')}`); break; }
      }
      for (const change of data.texts ?? []) {
        const node = this.nodes.get(change.id); if (node) node.textContent = change.value; else this.gaps.push(`Missing text node ${change.id}`);
      }
      for (const change of data.attributes ?? []) {
        const node = this.nodes.get(change.id); if (!node) { this.gaps.push(`Missing attribute node ${change.id}`); continue; }
        node.attributes ??= {};
        for (const [name, value] of Object.entries(change.attributes)) {
          if (value === null) delete node.attributes[name];
          else if (name === 'style' && typeof value === 'object') {
            node.attributes.style = applyStyle(String(node.attributes.style ?? ''), value as Record<string, any>);
          } else Object.defineProperty(node.attributes, name, { value, configurable: true, writable: true, enumerable: true });
        }
      }
    } else if (data.source === 5) {
      const node = this.nodes.get(data.id);
      if (node) { node.state ??= {}; node.state.value = data.text; node.state.checked = data.isChecked; }
      else this.gaps.push(`Missing input node ${data.id}`);
    } else if (data.source === 3) {
      const node = this.nodes.get(data.id); if (node) { node.state ??= {}; node.state.scroll = { x: data.x, y: data.y }; }
    } else if (data.source === 4) this.viewport = { width: data.width, height: data.height };
  }
  text(): string {
    const parts: string[] = [];
    const walk = (node: StateNode): void => {
      if (['script', 'style'].includes(node.tagName ?? '')) return;
      if (node.type === 3) parts.push(node.textContent ?? '');
      for (const child of node.childNodes ?? []) walk(child);
    };
    if (this.root) walk(this.root);
    return parts.join('');
  }
  missingFrames(): number {
    return [...this.nodes.values()].filter(node => node.tagName === 'iframe' && !node.childNodes?.some(child => child.type === 0)).length;
  }
}

export async function reconstruct(reader: TraceReader, input: { pageId: string; atSeq?: number; atTime?: number; format?: 'tree' | 'text' }): Promise<any> {
  const until = input.atSeq ?? reader.index.lastSeq;
  const candidates = reader.index.checkpoints.filter(c => c.pageId === input.pageId && c.seq <= until && (input.atTime === undefined || c.time <= input.atTime));
  const checkpoint = candidates.at(-1);
  if (!checkpoint) throw new RawTraceError('BASELINE_NOT_FOUND', 'No DOM baseline exists for this page at the requested point.');
  const dom = new DomState(); let documentId = checkpoint.documentId, url = '';
  const integrity: any[] = [...reader.recoveryGaps]; let appliedSeq = checkpoint.seq;
  let navigationPending = false;
  if (until >= reader.index.lastSeq && input.atTime === undefined && ['failed', 'interrupted'].includes(reader.manifest.status))
    integrity.push({ reason: reader.manifest.reason ?? reader.manifest.status });
  for await (const event of reader.events(checkpoint.seq - 1, until)) {
    if (input.atTime !== undefined && event.time > input.atTime) continue;
    if (event.pageId && event.pageId !== input.pageId) continue;
    const data = await reader.data(event);
    if (event.type === 'gap') integrity.push({ seq: event.seq, ...data });
    if (event.source === 'frames' && event.type === 'navigated' && data.isMainFrame) navigationPending = true;
    if (event.source !== 'dom') continue;
    if (event.type === 'baseline' || event.type === 'checkpoint') { dom.reset(data.node); dom.viewport = data.viewport; url = data.url ?? ''; documentId = event.documentId; navigationPending = false; }
    else if (event.documentId === documentId && event.type === 'delta') dom.apply(data);
    else if (event.type === 'location') url = data.url;
    appliedSeq = event.seq;
  }
  const target = reader.manifest.targets.find(t => t.targetId === input.pageId);
  const cookies = new Map<string, any>();
  // Cookie history is context scoped; DOM checkpoints do not reset it.
  for await (const event of reader.events(0, until)) {
    if (event.source !== 'cookies' || event.contextId !== target?.contextId || input.atTime !== undefined && event.time > input.atTime) continue;
    const data = await reader.data(event);
    if (event.type === 'baseline') { cookies.clear(); for (const cookie of data.cookies) cookies.set(cookieKey(cookie), cookie); }
    else { for (const key of data.removed ?? []) cookies.delete(key); for (const cookie of data.upsert ?? []) cookies.set(cookieKey(cookie), cookie); }
  }
  if (navigationPending) integrity.push('Navigation observed; new document baseline is not available at this point.');
  return { pageId: input.pageId, documentId, checkpointSeq: checkpoint.seq, appliedSeq, url,
    ...(input.format === 'text' ? { text: dom.text() } : { tree: dom.root }), viewport: dom.viewport,
    cookies: [...cookies.values()], cookieScope: reader.manifest.cookieScope,
    complete: integrity.length === 0 && dom.gaps.length === 0 && dom.missingFrames() === 0,
    gaps: [...integrity, ...dom.gaps, ...(dom.missingFrames() ? [`${dom.missingFrames()} iframe document(s) unavailable at requested point`] : [])],
    semantics: 'Observed serialized state; no script execution, external resources, or visual replay.' };
}
export function cookieKey(cookie: any): string { return JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey ?? null]); }

function applyStyle(current: string, delta: Record<string, any>): string {
  // Split declarations without splitting quoted strings or url()/function values.
  const declarations: string[] = []; let start = 0, depth = 0, quote = '', escaped = false;
  for (let index = 0; index <= current.length; index++) {
    const char = current[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') depth++; else if (char === ')') depth--;
    if (index === current.length || char === ';' && depth === 0) { declarations.push(current.slice(start, index)); start = index + 1; }
  }
  const values = new Map<string, string>();
  for (const declaration of declarations) {
    const colon = declaration.indexOf(':');
    if (colon >= 0) values.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
  }
  for (const [key, value] of Object.entries(delta)) {
    if (value === false || value === null) values.delete(key);
    else values.set(key, Array.isArray(value) ? `${value[0]}${value[1] ? ` !${value[1]}` : ''}` : String(value));
  }
  return [...values].map(([key, value]) => `${key}: ${value};`).join(' ');
}
