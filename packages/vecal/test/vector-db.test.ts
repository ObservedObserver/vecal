import { describe, it, expect, afterEach } from '@jest/globals';
import {
    DatabaseClosedError,
    IndexBuildConflictError,
    IndexNotReadyError,
    OperationCancelledError,
    RecordConflictError,
    RecordNotFoundError,
    SchemaMismatchError,
    UnsupportedEnvironmentError,
    ValidationError,
    VectorDB,
    type Metadata,
    type WorkerLike,
} from '../src/index.js';
import { serializeError } from '../src/errors.js';
import type { WorkerRequest, WorkerResponse } from '../src/protocol.js';
import { VectorDBRuntime } from '../src/runtime.js';

class MockWorker implements WorkerLike {
    private readonly messageListeners = new Set<(event: MessageEvent) => void>();
    private readonly errorListeners = new Set<(event: ErrorEvent) => void>();
    private readonly cancelled = new Set<number>();
    private readonly runtime = new VectorDBRuntime((status) => this.emit({ type: 'status', status }));

    postMessage(raw: unknown): void {
        const message = structuredClone(raw) as WorkerRequest;
        if (message.type === 'cancel') {
            this.cancelled.add(message.id);
            return;
        }
        queueMicrotask(() => {
            void this.runtime
                .execute(message.method, message.params, {
                    isCancelled: () => this.cancelled.has(message.id),
                    onProgress: (progress) => this.emit({ type: 'progress', id: message.id, progress }),
                })
                .then((result) => {
                    this.emit({ type: 'response', id: message.id, ok: true, result, status: this.runtime.status() });
                })
                .catch((error: unknown) => {
                    this.emit({
                        type: 'response',
                        id: message.id,
                        ok: false,
                        error: serializeError(error),
                        status: this.runtime.status(),
                    });
                })
                .finally(() => this.cancelled.delete(message.id));
        });
    }

    terminate(): void {}

    addEventListener(type: 'message' | 'error', listener: ((event: MessageEvent) => void) | ((event: ErrorEvent) => void)): void {
        if (type === 'message') this.messageListeners.add(listener as (event: MessageEvent) => void);
        else this.errorListeners.add(listener as (event: ErrorEvent) => void);
    }

    removeEventListener(
        type: 'message' | 'error',
        listener: ((event: MessageEvent) => void) | ((event: ErrorEvent) => void)
    ): void {
        if (type === 'message') this.messageListeners.delete(listener as (event: MessageEvent) => void);
        else this.errorListeners.delete(listener as (event: ErrorEvent) => void);
    }

    private emit(message: WorkerResponse): void {
        const event = { data: structuredClone(message) } as MessageEvent;
        for (const listener of this.messageListeners) listener(event);
    }
}

interface TestMetadata extends Metadata {
    label: string;
    group?: string;
    rating?: number;
}

let sequence = 0;
const opened: { name: string; db: VectorDB<TestMetadata> }[] = [];

function name(prefix = 'test'): string {
    return `${prefix}-${Date.now()}-${sequence++}`;
}

async function open(
    databaseName = name(),
    options: { dimension?: number; metric?: 'cosine' | 'l2' | 'dot' } = {}
): Promise<VectorDB<TestMetadata>> {
    const db = await VectorDB.open<TestMetadata>({
        name: databaseName,
        dimension: options.dimension ?? 3,
        metric: options.metric ?? 'cosine',
        workerFactory: () => new MockWorker(),
    });
    opened.push({ name: databaseName, db });
    return db;
}

async function deleteDatabase(databaseName: string): Promise<void> {
    await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(`vecal:${databaseName}:v1`);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
}

afterEach(async () => {
    const databases = opened.splice(0);
    await Promise.all(databases.map(({ db }) => db.close()));
    await Promise.all([...new Set(databases.map(({ name: databaseName }) => databaseName))].map(deleteDatabase));
});

describe('VectorDB 1.0 API', () => {
    it('supports atomic batch CRUD and generated ids', async () => {
        const db = await open();
        const ids = await db.addMany([
            { vector: new Float32Array([1, 0, 0]), metadata: { label: 'one' } },
            { id: 'two', vector: new Float32Array([0, 1, 0]), metadata: { label: 'two' } },
        ]);
        expect(ids[0]).toMatch(/[0-9a-f-]{36}/);
        expect(ids[1]).toBe('two');
        expect(await db.count()).toBe(2);
        expect((await db.get('two'))?.metadata?.label).toBe('two');
        expect((await db.getMany(['two', 'missing', ids[0]])).map((entry) => entry?.id)).toEqual([
            'two',
            undefined,
            ids[0],
        ]);

        await db.update('two', { metadata: { label: 'updated' } });
        expect((await db.get('two'))?.metadata).toEqual({ label: 'updated' });
        await db.upsert({ id: 'two', vector: new Float32Array([0, 0, 1]), metadata: { label: 'upserted' } });
        expect((await db.get('two'))?.vector).toEqual(new Float32Array([0, 0, 1]));
        expect(await db.delete('two')).toBe(true);
        expect(await db.delete('two')).toBe(false);
        expect(await db.deleteMany([ids[0], ids[0], 'missing'])).toBe(1);
        await db.clear();
        expect(await db.count()).toBe(0);
        expect(db.indexStatus().state).toBe('absent');
    });

    it('rolls back an entire addMany transaction on duplicate ids', async () => {
        const db = await open();
        await db.add({ id: 'existing', vector: new Float32Array([1, 0, 0]), metadata: { label: 'existing' } });
        await expect(
            db.addMany([
                { id: 'new', vector: new Float32Array([0, 1, 0]), metadata: { label: 'new' } },
                { id: 'existing', vector: new Float32Array([0, 0, 1]), metadata: { label: 'duplicate' } },
            ])
        ).rejects.toBeInstanceOf(RecordConflictError);
        expect(await db.get('new')).toBeUndefined();
        expect(await db.count()).toBe(1);
    });

    it('rejects schema changes for the same logical database', async () => {
        const databaseName = name('schema');
        await open(databaseName, { dimension: 3, metric: 'cosine' });
        await expect(open(databaseName, { dimension: 2, metric: 'cosine' })).rejects.toBeInstanceOf(SchemaMismatchError);
        await expect(open(databaseName, { dimension: 3, metric: 'l2' })).rejects.toBeInstanceOf(SchemaMismatchError);
    });

    it.each([
        ['cosine' as const, new Float32Array([1, 0]), new Float32Array([100, 0]), new Float32Array([1, 1]), 'aligned', 1],
        ['l2' as const, new Float32Array([1, 0]), new Float32Array([100, 0]), new Float32Array([1, 1]), 'near', -1],
        ['dot' as const, new Float32Array([1, 0]), new Float32Array([100, 0]), new Float32Array([1, 1]), 'aligned', 100],
    ])('uses the configured %s metric consistently', async (metric, query, aligned, near, expected, expectedScore) => {
        const db = await open(name(metric), { dimension: 2, metric });
        await db.addMany([
            { id: 'aligned', vector: aligned, metadata: { label: 'aligned' } },
            { id: 'near', vector: near, metadata: { label: 'near' } },
        ]);
        const exact = (await db.search(query, { k: 1, strategy: 'exact' }))[0];
        expect(exact.id).toBe(expected);
        expect(exact.score).toBeCloseTo(expectedScore);
        await db.ensureIndex({ type: 'hnsw', m: 4, efConstruction: 20 });
        const hnsw = (await db.search(query, { k: 1, strategy: 'hnsw', efSearch: 20 }))[0];
        expect(hnsw.id).toBe(expected);
        expect(hnsw.score).toBeCloseTo(expectedScore);
    });

    it('supports structured filters, thresholds, and deterministic ties', async () => {
        const db = await open();
        await db.addMany([
            { id: 'a', vector: new Float32Array([1, 0, 0]), metadata: { label: 'A', group: 'keep', rating: 5 } },
            { id: 'b', vector: new Float32Array([1, 0, 0]), metadata: { label: 'B', group: 'drop', rating: 4 } },
            { id: 'c', vector: new Float32Array([0, 1, 0]), metadata: { label: 'C', group: 'keep', rating: 2 } },
        ]);
        const results = await db.search(new Float32Array([1, 0, 0]), {
            k: 3,
            strategy: 'exact',
            where: { group: { $in: ['keep'] }, rating: { $gte: 3 } },
            minScore: 0.5,
        });
        expect(results.map((result) => result.id)).toEqual(['a']);
        expect((await db.search(new Float32Array([1, 0, 0]), { k: 2 })).map((result) => result.id)).toEqual(['a', 'b']);
        expect(
            (
                await db.search(new Float32Array([1, 0, 0]), {
                    k: 3,
                    strategy: 'exact',
                    where: { group: ['keep', 'drop'], rating: { $gt: 2, $lte: 4 } },
                })
            ).map(({ id }) => id)
        ).toEqual(['b']);
        expect(
            (
                await db.search(new Float32Array([1, 0, 0]), {
                    k: 3,
                    strategy: 'exact',
                    where: { rating: { $lt: 5, $gte: 2 } },
                })
            ).map(({ id }) => id)
        ).toEqual(['b', 'c']);
    });

    it('breaks equal scores by locale-independent id order', async () => {
        const db = await open();
        await db.addMany(
            ['z', 'ä', 'a'].map((id) => ({
                id,
                vector: new Float32Array([1, 0, 0]),
                metadata: { label: id },
            }))
        );
        const expected = ['a', 'z', 'ä'];
        expect((await db.search(new Float32Array([1, 0, 0]), { k: 3, strategy: 'exact' })).map(({ id }) => id)).toEqual(
            expected
        );
        await db.ensureIndex({ type: 'hnsw', m: 4, efConstruction: 20 });
        expect((await db.search(new Float32Array([1, 0, 0]), { k: 3, strategy: 'hnsw' })).map(({ id }) => id)).toEqual(
            expected
        );
    });

    it('persists and restores an HNSW snapshot', async () => {
        const databaseName = name('snapshot');
        const first = await open(databaseName);
        await first.addMany([
            { id: 'a', vector: new Float32Array([1, 0, 0]), metadata: { label: 'A' } },
            { id: 'b', vector: new Float32Array([0, 1, 0]), metadata: { label: 'B' } },
        ]);
        await first.ensureIndex({ type: 'hnsw', m: 4, efConstruction: 20, seed: 7 });
        expect(first.indexStatus().state).toBe('ready');
        await first.add({ id: 'c', vector: new Float32Array([0, 0, 1]), metadata: { label: 'C' } });
        await first.close();

        const second = await open(databaseName);
        expect(second.indexStatus().state).toBe('ready');
        expect((await second.search(new Float32Array([0, 0, 1]), { k: 1, strategy: 'hnsw' }))[0].id).toBe('c');
    });

    it('increments an index and marks it stale after too many tombstones', async () => {
        const db = await open();
        await db.addMany(
            Array.from({ length: 12 }, (_, index) => ({
                id: `v${index}`,
                vector: new Float32Array([1, index / 20 + 0.01, 0]),
                metadata: { label: `v${index}` },
            }))
        );
        await db.ensureIndex({ type: 'hnsw', m: 4, efConstruction: 20 });
        await db.add({ id: 'new', vector: new Float32Array([0, 0, 1]), metadata: { label: 'new' } });
        expect(db.indexStatus().state).toBe('ready');
        expect((await db.search(new Float32Array([0, 0, 1]), { k: 1, strategy: 'hnsw' }))[0].id).toBe('new');
        await db.update('v0', { vector: new Float32Array([0, 1, 0]) });
        await db.delete('v1');
        expect(db.indexStatus().state).toBe('stale');
        await expect(db.search(new Float32Array([1, 0, 0]), { k: 1, strategy: 'hnsw' })).rejects.toBeInstanceOf(
            IndexNotReadyError
        );
        expect((await db.search(new Float32Array([1, 0, 0]), { k: 1, strategy: 'auto' })).length).toBe(1);
        await db.ensureIndex({ type: 'hnsw' });
        expect(db.indexStatus().state).toBe('ready');
    });

    it('observes committed changes made by another instance at the next operation', async () => {
        const databaseName = name('tabs');
        const first = await open(databaseName);
        const second = await open(databaseName);
        await first.add({ id: 'shared', vector: new Float32Array([1, 0, 0]), metadata: { label: 'first' } });
        expect((await second.get('shared'))?.metadata?.label).toBe('first');
        await first.ensureIndex({ type: 'hnsw' });
        await second.update('shared', { metadata: { label: 'second' } });
        expect((await first.get('shared'))?.metadata?.label).toBe('second');
        expect(first.indexStatus().state).toBe('stale');
    });

    it('serializes concurrent writes from separate workers without losing a revision', async () => {
        const databaseName = name('concurrent');
        const first = await open(databaseName);
        const second = await open(databaseName);
        await Promise.all([
            first.add({ id: 'first', vector: new Float32Array([1, 0, 0]), metadata: { label: 'first' } }),
            second.add({ id: 'second', vector: new Float32Array([0, 1, 0]), metadata: { label: 'second' } }),
        ]);
        expect(await first.count()).toBe(2);
        expect(first.indexStatus().revision).toBe(2);
        expect(await second.count()).toBe(2);
        expect(second.indexStatus().revision).toBe(2);
    });

    it('ignores an outdated snapshot after an uncheckpointed external commit', async () => {
        const databaseName = name('stale-snapshot');
        const first = await open(databaseName);
        await first.add({ id: 'first', vector: new Float32Array([1, 0, 0]), metadata: { label: 'first' } });
        await first.ensureIndex({ type: 'hnsw' });
        await first.close();

        const raw = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(`vecal:${databaseName}:v1`);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const transaction = raw.transaction(['entries', 'meta'], 'readwrite');
        transaction.objectStore('entries').add({
            id: 'external',
            vector: new Float32Array([0, 1, 0]),
            metadata: { label: 'external' },
        });
        const meta = transaction.objectStore('meta');
        const schemaRequest = meta.get('schema');
        schemaRequest.onsuccess = () => meta.put({ ...schemaRequest.result, revision: schemaRequest.result.revision + 1 });
        await new Promise<void>((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = transaction.onabort = () => reject(transaction.error);
        });
        raw.close();

        const reopened = await open(databaseName);
        expect(reopened.indexStatus().state).toBe('stale');
        expect((await reopened.search(new Float32Array([0, 1, 0]), { k: 1, strategy: 'auto' }))[0].id).toBe('external');
    });

    it('cancels an in-progress index build', async () => {
        const db = await open();
        await db.addMany(
            Array.from({ length: 160 }, (_, index) => ({
                id: String(index),
                vector: new Float32Array([1, (index + 1) / 200, 0]),
                metadata: { label: String(index) },
            }))
        );
        const controller = new AbortController();
        const promise = db.ensureIndex({
            type: 'hnsw',
            signal: controller.signal,
            onProgress: (progress) => {
                if (progress.completed >= 32) controller.abort();
            },
        });
        await expect(promise).rejects.toBeInstanceOf(OperationCancelledError);
    });

    it('cancels exact search and reports repeated build revision conflicts', async () => {
        const databaseName = name('cancel-conflict');
        const db = await open(databaseName);
        const writer = await open(databaseName);
        await db.addMany(
            Array.from({ length: 160 }, (_, index) => ({
                id: String(index),
                vector: new Float32Array([1, (index + 1) / 200, 0]),
                metadata: { label: String(index) },
            }))
        );

        const controller = new AbortController();
        const search = db.search(new Float32Array([1, 0, 0]), { k: 10, strategy: 'exact', signal: controller.signal });
        controller.abort();
        await expect(search).rejects.toBeInstanceOf(OperationCancelledError);

        let attempt = -1;
        const writes: Promise<string>[] = [];
        const build = db.ensureIndex({
            type: 'hnsw',
            onProgress: (progress) => {
                if (progress.completed === 0) attempt++;
                if (progress.completed === 128 && attempt < 2) {
                    writes.push(
                        writer.add({
                            id: `conflict-${attempt}`,
                            vector: new Float32Array([0, 1, (attempt + 1) / 10]),
                            metadata: { label: `conflict-${attempt}` },
                        })
                    );
                }
            },
        });
        await expect(build).rejects.toBeInstanceOf(IndexBuildConflictError);
        await Promise.all(writes);
    });

    it('validates vectors, metadata, filters, and update targets', async () => {
        const db = await open();
        await expect(db.add({ vector: new Float32Array([0, 0, 0]), metadata: { label: 'zero' } })).rejects.toBeInstanceOf(
            ValidationError
        );
        await expect(
            db.add({ vector: new Float32Array([1, Number.NaN, 0]), metadata: { label: 'nan' } })
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(
            db.add({ vector: new Float32Array([1, 0, 0]), metadata: { label: 'bad', optional: undefined } as never })
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(
            db.search(new Float32Array([1, 0, 0]), { where: { 'nested.field': { $eq: 'x' } } })
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(
            db.search(new Float32Array([1, 0, 0]), { where: (() => true) as never })
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(
            db.search(new Float32Array([1, 0, 0]), { where: { rating: { $gte: Number.POSITIVE_INFINITY } } })
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(db.update('missing', { metadata: { label: 'missing' } })).rejects.toBeInstanceOf(RecordNotFoundError);
    });

    it('normalizes Worker startup failures and conflicting Worker overrides', async () => {
        await expect(
            VectorDB.open({
                name: name('worker-failure'),
                dimension: 3,
                metric: 'cosine',
                workerFactory: () => {
                    throw new Error('blocked by policy');
                },
            })
        ).rejects.toBeInstanceOf(UnsupportedEnvironmentError);
        await expect(
            VectorDB.open({
                name: name('worker-options'),
                dimension: 3,
                metric: 'cosine',
                workerUrl: new URL('https://example.test/worker.js'),
                workerFactory: () => new MockWorker(),
            })
        ).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws stable errors after close', async () => {
        const db = await open();
        await db.close();
        await expect(db.count()).rejects.toBeInstanceOf(DatabaseClosedError);
    });
});
