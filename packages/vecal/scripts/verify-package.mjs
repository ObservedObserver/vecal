import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = ['dist/index.js', 'dist/index.d.ts', 'dist/worker.js', 'README.md', 'LICENSE'];
for (const file of requiredFiles) await access(resolve(directory, file), constants.R_OK);

const module = await import(resolve(directory, 'dist/index.js'));
if (typeof module.VectorDB !== 'function') throw new Error('VectorDB export is missing');

const packageJson = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
if (packageJson.types !== './dist/index.d.ts') throw new Error('Package types entry is incorrect');
if (packageJson.exports?.['./worker']?.import !== './dist/worker.js') throw new Error('Worker export is incorrect');

const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: directory,
    encoding: 'utf8',
});
if (packed.status !== 0) throw new Error(packed.stderr || 'npm pack dry-run failed');
const packResult = JSON.parse(packed.stdout)[0];
const packedFiles = new Set(packResult.files.map((file) => file.path));
for (const file of requiredFiles) {
    if (!packedFiles.has(file)) throw new Error(`${file} is missing from the npm tarball`);
}

const runtimeFiles = (await readdir(resolve(directory, 'dist'))).filter((file) => file.endsWith('.js'));
let gzipBytes = 0;
for (const file of runtimeFiles) gzipBytes += gzipSync(await readFile(resolve(directory, 'dist', file))).byteLength;
if (gzipBytes > 40 * 1024) throw new Error(`Runtime gzip size ${gzipBytes} bytes exceeds the 40 KB gate`);

console.log(
    `Verified ${packageJson.name}@${packageJson.version} runtime, types, worker, README, LICENSE, and ` +
        `${(gzipBytes / 1024).toFixed(1)} KB aggregate runtime gzip`
);
