import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceDirectory = resolve(packageDirectory, '../..');
const fixtureDirectory = resolve(packageDirectory, 'test/fixtures');
const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'vecal-consumer-'));
const verifyBrowserRuntime = process.argv.includes('--browser');

function run(command, arguments_, cwd) {
    const result = spawnSync(command, arguments_, { cwd, encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) {
        throw new Error(
            `${command} ${arguments_.join(' ')} failed in ${cwd}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
        );
    }
    return result.stdout.trim();
}

async function linkDependency(project, dependency) {
    const destination = resolve(project, 'node_modules', dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(resolve(workspaceDirectory, 'node_modules', dependency), destination, 'junction');
}

async function availablePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function verifyViteRuntime(project) {
    const port = await availablePort();
    const preview = spawn(
        resolve(workspaceDirectory, 'node_modules/.bin/vite'),
        ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
        { cwd: project, stdio: 'ignore' }
    );
    try {
        const url = `http://127.0.0.1:${port}`;
        for (let attempt = 0; attempt < 100; attempt++) {
            try {
                if ((await fetch(url)).ok) break;
            } catch {
                // The preview server is still starting.
            }
            if (attempt === 99) throw new Error('Vite preview did not start');
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const { chromium } = await import('@playwright/test');
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage();
            await page.goto(url);
            await page.locator('#app').click();
            await page.waitForFunction(() => document.querySelector('#app')?.textContent?.startsWith('ready:'), undefined, {
                timeout: 30_000,
            });
            const status = await page.locator('#app').textContent();
            if (status !== 'ready:runtime') throw new Error(`Unexpected Vite runtime status: ${status}`);
        } finally {
            await browser.close();
        }
    } finally {
        preview.kill('SIGTERM');
    }
}

try {
    const packOutput = run(
        'npm',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryDirectory],
        packageDirectory
    );
    const filename = JSON.parse(packOutput)[0].filename;
    const tarball = resolve(temporaryDirectory, basename(filename));

    for (const fixture of ['native-esm', 'vite', 'next']) {
        const project = resolve(temporaryDirectory, fixture);
        await cp(resolve(fixtureDirectory, fixture), project, { recursive: true });
        run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', tarball], project);

        if (fixture === 'native-esm') {
            run(process.execPath, ['index.mjs'], project);
            run(resolve(workspaceDirectory, 'node_modules/.bin/tsc'), ['--noEmit'], project);
        } else if (fixture === 'vite') {
            await linkDependency(project, 'vite');
            await linkDependency(project, 'typescript');
            run(resolve(workspaceDirectory, 'node_modules/.bin/vite'), ['build'], project);
            const builtHtml = await readFile(resolve(project, 'dist/index.html'), 'utf8');
            if (!builtHtml.includes('/assets/')) throw new Error('Vite fixture did not emit an application asset');
            const viteFiles = await readdir(resolve(project, 'dist'), { recursive: true });
            const viteWorker = viteFiles.find((file) => /^assets\/worker-.*\.js$/.test(file));
            if (!viteWorker) throw new Error('Vite fixture did not emit the Vecal Worker bundle');
            const viteWorkerSource = await readFile(resolve(project, 'dist', viteWorker), 'utf8');
            if (!viteWorkerSource.includes('index_snapshots')) {
                throw new Error('Vite Worker bundle is missing the Vecal runtime');
            }
            if (verifyBrowserRuntime) await verifyViteRuntime(project);
        } else {
            for (const dependency of ['next', 'react', 'react-dom', 'typescript', '@types']) {
                await linkDependency(project, dependency);
            }
            run(resolve(workspaceDirectory, 'node_modules/.bin/next'), ['build'], project);
            const nextFiles = (await readdir(resolve(project, '.next'), { recursive: true })).filter((file) =>
                file.endsWith('.js')
            );
            let hasBundledWorker = false;
            for (const file of nextFiles) {
                if ((await readFile(resolve(project, '.next', file), 'utf8')).includes('index_snapshots')) {
                    hasBundledWorker = true;
                    break;
                }
            }
            if (!hasBundledWorker) throw new Error('Next.js fixture did not emit the Vecal Worker runtime');
        }
    }

    console.log(
        `Verified npm tarball consumers: native ESM, Vite${verifyBrowserRuntime ? ' browser runtime' : ''}, and ` +
            'Next.js client component'
    );
} finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
}
