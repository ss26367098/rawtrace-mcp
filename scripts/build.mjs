import { build } from 'esbuild';
import { rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const output = fileURLToPath(new URL('../dist/', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
// Fixed workspace build-output path; never derive deletion targets from user input.
if (!output.startsWith(root) || !output.endsWith('dist\\') && !output.endsWith('dist/')) throw new Error('Invalid build directory');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
await build({ entryPoints: ['src/capture/browser.ts'], bundle: true, format: 'iife', globalName: 'RawTraceRecorder',
  platform: 'browser', target: 'es2022', minify: true, outfile: 'dist/browser-recorder.js' });
