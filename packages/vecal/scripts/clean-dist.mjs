import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(packageDirectory, 'dist');
if (basename(target) !== 'dist' || !target.startsWith(`${packageDirectory}/`)) {
    throw new Error(`Refusing to clean unexpected build path: ${target}`);
}
await rm(target, { recursive: true, force: true });
