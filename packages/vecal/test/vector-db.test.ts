import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { VectorDB, HNSWIndex } from '../src';

const CONFIG = { dbName: 'jest-db', dimension: 3 };

const VEC_APPLE = new Float32Array([0.9, 0.1, 0.1]);
const VEC_BANANA = new Float32Array([0.1, 0.9, 0.1]);
const VEC_CHERRY = new Float32Array([0.1, 0.1, 0.9]);
const QUERY_VEC = new Float32Array([0.85, 0.2, 0.15]);

let db: VectorDB;

beforeEach(() => {
  db = new VectorDB(CONFIG);
});

afterEach(async () => {
  await db.close();
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(CONFIG.dbName);
    req.onsuccess = () => resolve(null);
    req.onerror = () => resolve(null);
  });
});

describe('VectorDB basic operations', () => {
  it('adds and retrieves vectors', async () => {
    const id = await db.add(VEC_APPLE, { label: 'Apple' });
    const entry = await db.get(id);
    expect(entry?.metadata?.label).toBe('Apple');
  });

  it('updates entries', async () => {
    const id = await db.add(VEC_BANANA, { label: 'Banana' });
    await db.update(id, { 
      vector: VEC_BANANA,
      metadata: { label: 'Updated' } 
    });
    const updated = await db.get(id);
    expect(updated?.metadata?.label).toBe('Updated');
  }, 10000);

  it('avoids count calls when updating entries', async () => {
    const originalCount = IDBObjectStore.prototype.count;
    let countCalls = 0;

    (IDBObjectStore.prototype as any).count = function (...args: any[]) {
      countCalls++;
      return (originalCount as any).apply(this, args);
    };

    try {
      const id = await db.add(VEC_BANANA, { label: 'Banana' });
      countCalls = 0;

      await db.update(id, { metadata: { label: 'Updated once' } });
      await db.update(id, { metadata: { label: 'Updated twice' } });

      expect(countCalls).toBe(0);
    } finally {
      (IDBObjectStore.prototype as any).count = originalCount;
    }
  });

  it('deletes entries', async () => {
    const id = await db.add(VEC_CHERRY, { label: 'Cherry' });
    await db.delete(id);
    const deleted = await db.get(id);
    expect(deleted).toBeUndefined();
  });

  it('performs similarity search', async () => {
    const id1 = await db.add(VEC_APPLE, { label: 'Apple' });
    await db.add(VEC_BANANA, { label: 'Banana' });
    await db.add(VEC_CHERRY, { label: 'Cherry' });

    const results = await db.search(QUERY_VEC, 2);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe(id1); // Apple should be closest
  });

  it('supports Manhattan distance', async () => {
    await db.add(VEC_APPLE, { label: 'Apple' });
    await db.add(VEC_BANANA, { label: 'Banana' });
    const results = await db.search(QUERY_VEC, 1, 'l1');
    expect(results[0].metadata?.label).toBe('Apple');
  });

  it('supports dot product search', async () => {
    await db.add(VEC_APPLE, { label: 'Apple' });
    await db.add(VEC_BANANA, { label: 'Banana' });
    const results = await db.search(QUERY_VEC, 1, 'dot');
    expect(results[0].metadata?.label).toBe('Apple');
  });

  it('supports metadata filters and minimum score for exact search', async () => {
    await db.add(VEC_APPLE, { label: 'Apple', category: 'fruit', rating: 5 });
    await db.add(VEC_BANANA, { label: 'Banana', category: 'fruit', rating: 2 });
    await db.add(VEC_CHERRY, { label: 'Cherry', category: 'berry', rating: 4 });

    const objectFilter = await db.search(QUERY_VEC, 3, 'cosine', {
      filter: { category: 'fruit' },
    });
    expect(objectFilter).toHaveLength(2);
    expect(objectFilter.every((r) => r.metadata?.category === 'fruit')).toBe(true);

    const functionFilter = await db.search(QUERY_VEC, 3, 'cosine', {
      filter: (entry) => (entry.metadata?.rating ?? 0) >= 4,
    });
    expect(functionFilter).toHaveLength(2);
    expect(functionFilter.every((r) => (r.metadata?.rating ?? 0) >= 4)).toBe(true);

    const highScoreOnly = await db.search(QUERY_VEC, 3, 'cosine', { minScore: 0.9 });
    expect(highScoreOnly.length).toBeGreaterThan(0);
    expect(highScoreOnly.every((r) => r.score >= 0.9)).toBe(true);
  });

  it('builds index and performs ANN search', async () => {
    const id1 = await db.add(VEC_APPLE, { label: 'Apple' });
    await db.add(VEC_BANANA, { label: 'Banana' });
    await db.add(VEC_CHERRY, { label: 'Cherry' });

    await db.buildIndex(8);
    const results = await db.annSearch(QUERY_VEC, 2);
    expect(results.length).toBe(2);
    const ids = results.map(r => r.id);
    expect(ids).toContain(id1);
  });

  it('updates index on delete', async () => {
    const id1 = await db.add(VEC_APPLE, { label: 'Apple' });
    await db.add(VEC_BANANA, { label: 'Banana' });
    await db.buildIndex();
    await db.delete(id1);

    const results = await db.annSearch(VEC_APPLE, 2);
    const ids = results.map(r => r.id);
    expect(ids).not.toContain(id1);
  });

  it('rejects dimension mismatch', async () => {
    const wrong = new Float32Array([1, 2]);
    await expect(db.add(wrong)).rejects.toThrow();
  });

  it('builds IVF index and searches with cache', async () => {
    const id = await db.add(VEC_APPLE, { label: 'Apple' });
    await db.add(VEC_BANANA, { label: 'Banana' });
    await db.add(VEC_CHERRY, { label: 'Cherry' });
    await db.buildIVFFlatIndex(2, 1);
    const results = await db.ivfSearch(QUERY_VEC, 2);
    const ids = results.map(r => r.id);
    expect(ids).toContain(id);
    const cached = await db.get(id);
    expect(cached?.metadata?.label).toBe('Apple');
  });

  it('builds HNSW index and performs search', async () => {
    const id = await db.add(VEC_APPLE, { label: 'Apple' });
    await db.add(VEC_BANANA, { label: 'Banana' });
    await db.add(VEC_CHERRY, { label: 'Cherry' });
    await db.buildHNSWIndex();
    const results = await db.hnswSearch(QUERY_VEC, 2);
    const ids = results.map(r => r.id);
    expect(ids).toContain(id);
  });

  it('applies metadata filters to ANN search methods', async () => {
    const appleId = await db.add(VEC_APPLE, { label: 'Apple', group: 'keep' });
    const bananaId = await db.add(VEC_BANANA, { label: 'Banana', group: 'drop' });
    const cherryId = await db.add(VEC_CHERRY, { label: 'Cherry', group: 'keep' });

    await db.buildIndex(8);
    const lshFiltered = await db.annSearch(QUERY_VEC, 3, 1, 'cosine', { filter: { group: 'drop' } });
    expect(lshFiltered).toHaveLength(1);
    expect(lshFiltered[0].id).toBe(bananaId);

    await db.buildIVFFlatIndex(2, 2);
    const ivfFiltered = await db.ivfSearch(QUERY_VEC, 3, { filter: { group: 'keep' } });
    const ivfIds = ivfFiltered.map((r) => r.id);
    expect(ivfIds).toContain(appleId);
    expect(ivfIds).toContain(cherryId);
    expect(ivfIds).not.toContain(bananaId);

    await db.buildHNSWIndex();
    const hnswFiltered = await db.hnswSearch(QUERY_VEC, 3, 64, {
      filter: (entry) => entry.metadata?.group === 'keep',
    });
    const hnswIds = hnswFiltered.map((r) => r.id);
    expect(hnswIds).toContain(appleId);
    expect(hnswIds).toContain(cherryId);
    expect(hnswIds).not.toContain(bananaId);
  });

  it('builds HNSW index through worker path and performs search', async () => {
    const OriginalWorker = globalThis.Worker;

    class MockWorker {
      onmessage: ((ev: MessageEvent<{ type: 'done'; index: ReturnType<HNSWIndex['serialize']> }>) => void) | null = null;
      onerror: ((ev: ErrorEvent) => void) | null = null;

      postMessage(message: { dim: number; m: number; efConstruction: number; entries: { id: string; vector: Float32Array }[] }) {
        const index = new HNSWIndex(message.dim, message.m, message.efConstruction);
        index.build(message.entries);
        setTimeout(() => {
          this.onmessage?.({
            data: { type: 'done', index: index.serialize() },
          } as MessageEvent<{ type: 'done'; index: ReturnType<HNSWIndex['serialize']> }>);
        }, 0);
      }

      terminate() {}
    }

    (globalThis as any).Worker = MockWorker;

    try {
      const id = await db.add(VEC_APPLE, { label: 'Apple' });
      await db.add(VEC_BANANA, { label: 'Banana' });
      await db.buildHNSWIndex();
      const results = await db.hnswSearch(VEC_APPLE, 1);
      expect(results[0].id).toBe(id);
    } finally {
      (globalThis as any).Worker = OriginalWorker;
    }
  });

  it('rebuilds HNSW index when data changes', async () => {
    const bananaId = await db.add(VEC_BANANA, { label: 'Banana' });
    await db.buildHNSWIndex();

    const appleId = await db.add(VEC_APPLE, { label: 'Apple' });
    const afterAdd = await db.hnswSearch(VEC_APPLE, 1);
    expect(afterAdd[0].id).toBe(appleId);

    await db.update(bananaId, { vector: VEC_APPLE, metadata: { label: 'Banana->Apple' } });
    const afterUpdate = await db.hnswSearch(VEC_APPLE, 2);
    expect(afterUpdate.map(r => r.id)).toContain(bananaId);

    await db.delete(appleId);
    const afterDelete = await db.hnswSearch(VEC_APPLE, 2);
    expect(afterDelete.map(r => r.id)).not.toContain(appleId);
  });

  it('keeps or improves recall with larger HNSW efSearch', async () => {
    for (let i = 0; i < 80; i++) {
      const vec = new Float32Array([
        ((i * 17) % 100) / 100,
        ((i * 29) % 100) / 100,
        ((i * 43) % 100) / 100,
      ]);
      await db.add(vec, { idx: i });
    }

    await db.buildHNSWIndex(8, 64);
    const query = new Float32Array([0.52, 0.37, 0.91]);
    const k = 10;

    const exact = await db.search(query, k, 'l2');
    const lowEf = await db.hnswSearch(query, k, 8);
    const highEf = await db.hnswSearch(query, k, 64);

    const exactSet = new Set(exact.map((r) => r.id));
    const lowOverlap = lowEf.filter((r) => exactSet.has(r.id)).length;
    const highOverlap = highEf.filter((r) => exactSet.has(r.id)).length;

    expect(highOverlap).toBeGreaterThanOrEqual(lowOverlap);
  });

  it('throws clear errors after close', async () => {
    await db.close();

    await expect(db.add(VEC_APPLE)).rejects.toThrow('Database is closed');
    await expect(db.get('non-existent')).rejects.toThrow('Database is closed');
    await expect(db.search(QUERY_VEC)).rejects.toThrow('Database is closed');
  });

  it('exports VectorDB from public entry', async () => {
    const mod = await import('../src/index');
    expect(mod.VectorDB).toBeDefined();
  });
});
