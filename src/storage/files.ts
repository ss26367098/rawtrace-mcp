import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { RawTraceError } from '../errors.js';

export const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export async function atomic(path: string, value: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, value, { flag: 'wx' });
  await rename(temp, path);
}
export async function inside(root: string, path: string): Promise<string> {
  const base = await realpath(root);
  const candidate = await realpath(resolve(root, path));
  const rel = relative(base, candidate);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new RawTraceError('PATH_OUTSIDE_TRACE', 'Path resolves outside the trace directory.');
  }
  return candidate;
}
export async function jsonFile<T>(root: string, path: string): Promise<T> {
  return JSON.parse(await readFile(await inside(root, path), 'utf8')) as T;
}
