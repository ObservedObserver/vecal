import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { VectorDB } from '../src';

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

    try {
      console.log('start')
      const results = await db.search(QUERY_VEC, 2);
      console.log('DEBUG_RESULTS', results);
      expect(results.length).toBe(2);
      expect(results[0].id).toBe(id1); // Apple should be closest
    } catch (err) {
      console.error('SEARCH_ERROR', err);
      throw err;
    }
  });

  it('rejects dimension mismatch', async () => {
    const wrong = new Float32Array([1, 2]);
    await expect(db.add(wrong)).rejects.toThrow();
  });
});
