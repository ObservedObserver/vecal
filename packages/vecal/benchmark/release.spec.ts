import { expect, test } from '@playwright/test';

const datasets = [
    { count: 50_000, dimension: 384 },
    { count: 10_000, dimension: 1536 },
];

test.describe('release performance gates', () => {
    test.skip(process.env.VECAL_RELEASE_BENCHMARK !== '1', 'Run with yarn test:benchmark');

    for (const dataset of datasets) {
        test(`${dataset.count}x${dataset.dimension}`, async ({ page }, testInfo) => {
            await page.goto('/benchmark/');
            await expect(page.locator('#status')).toHaveText('ready');
            const result = await page.evaluate(
                ({ name, count, dimension }) => window.vecalBenchmark.run(name, count, dimension),
                {
                    name: `release-${testInfo.project.name}-${dataset.count}-${dataset.dimension}-${Date.now()}`,
                    ...dataset,
                }
            );
            console.log(JSON.stringify(result));
            await testInfo.attach('benchmark.json', {
                body: JSON.stringify(result, null, 2),
                contentType: 'application/json',
            });
            expect(result.recallAt10).toBeGreaterThanOrEqual(0.95);
            expect(result.buildMs).toBeLessThanOrEqual(60_000);
            expect(result.warmP95Ms).toBeLessThanOrEqual(100);
            expect(result.maxMainThreadLongTaskMs).toBeLessThanOrEqual(50);
            expect(result.measuredMemoryBytes).toBeDefined();
            expect(result.measuredMemoryBytes!).toBeLessThanOrEqual(350 * 1024 * 1024);
        });
    }
});
