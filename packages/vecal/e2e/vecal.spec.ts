import { expect, test } from '@playwright/test';

async function ready(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/e2e/');
    await expect(page.locator('#status')).toHaveText('ready');
}

test('loads the packaged module Worker and restores a persisted snapshot', async ({ page }, testInfo) => {
    await ready(page);
    const name = `snapshot-${testInfo.project.name}-${Date.now()}`;
    const first = await page.evaluate(async (databaseName) => {
        await window.vecalHarness.open(databaseName);
        await window.vecalHarness.add('a', [1, 0, 0], 'A');
        await window.vecalHarness.add('b', [0, 1, 0], 'B');
        const built = await window.vecalHarness.build();
        const result = await window.vecalHarness.search([1, 0, 0]);
        await window.vecalHarness.close();
        return { built, firstId: result[0]?.id };
    }, name);
    expect(first.built.state).toBe('ready');
    expect(first.firstId).toBe('a');

    await page.reload();
    await expect(page.locator('#status')).toHaveText('ready');
    const restored = await page.evaluate(async (databaseName) => {
        const status = await window.vecalHarness.open(databaseName);
        const result = await window.vecalHarness.search([1, 0, 0]);
        return { status, firstId: result[0]?.id };
    }, name);
    expect(restored.status.state).toBe('ready');
    expect(restored.firstId).toBe('a');
});

test('observes cross-tab commits and invalidates an index', async ({ context, page }, testInfo) => {
    const secondPage = await context.newPage();
    await Promise.all([ready(page), ready(secondPage)]);
    const name = `tabs-${testInfo.project.name}-${Date.now()}`;
    await page.evaluate((databaseName) => window.vecalHarness.open(databaseName), name);
    await secondPage.evaluate((databaseName) => window.vecalHarness.open(databaseName), name);
    await page.evaluate(() => window.vecalHarness.add('shared', [1, 0, 0], 'first'));
    expect(await secondPage.evaluate(() => window.vecalHarness.getLabel('shared'))).toBe('first');
    await page.evaluate(() => window.vecalHarness.build());
    await secondPage.evaluate(() => window.vecalHarness.updateLabel('shared', 'second'));
    expect(await page.evaluate(() => window.vecalHarness.getLabel('shared'))).toBe('second');
    expect(await page.evaluate(() => window.vecalHarness.status().state)).toBe('stale');
});

test('falls back to exact search for selective metadata filters', async ({ page }, testInfo) => {
    await ready(page);
    const name = `filter-${testInfo.project.name}-${Date.now()}`;
    const ids = await page.evaluate(async (databaseName) => {
        await window.vecalHarness.open(databaseName, true);
        for (let index = 0; index < 30; index++) {
            await window.vecalHarness.add(`drop-${index}`, [1, 0.01 + index / 10_000, 0], `drop-${index}`, 'drop');
        }
        for (let index = 0; index < 5; index++) {
            await window.vecalHarness.add(`keep-${index}`, [0.4, 0.6 + index / 100, 0], `keep-${index}`, 'keep');
        }
        await window.vecalHarness.build();
        return (await window.vecalHarness.search([1, 0, 0], 'keep')).map((result) => result.id);
    }, name);
    expect(ids).toHaveLength(5);
    expect(ids.every((id) => id.startsWith('keep-'))).toBe(true);
});

test('rejects operations after close', async ({ page }, testInfo) => {
    await ready(page);
    const error = await page.evaluate(async (databaseName) => {
        await window.vecalHarness.open(databaseName);
        await window.vecalHarness.close();
        try {
            await window.vecalHarness.count();
            return '';
        } catch (caught) {
            return caught instanceof Error ? `${caught.name}:${caught.message}` : String(caught);
        }
    }, `close-${testInfo.project.name}-${Date.now()}`);
    expect(error).toContain('DatabaseClosedError');
});
