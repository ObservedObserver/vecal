import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './benchmark',
    testMatch: 'release.spec.ts',
    timeout: 20 * 60_000,
    workers: 1,
    fullyParallel: false,
    reporter: [['line'], ['json', { outputFile: 'output/playwright/benchmark.json' }]],
    use: {
        baseURL: 'http://127.0.0.1:4174',
        trace: 'retain-on-failure',
    },
    projects: [{ name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' } }],
    webServer: {
        command: 'yarn build && yarn vite --host 127.0.0.1 --port 4174',
        port: 4174,
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
