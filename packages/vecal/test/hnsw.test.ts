import { describe, expect, it } from '@jest/globals';
import { HNSWIndex } from '../src/hnsw.js';
import { metricScore } from '../src/math.js';

function deterministicVectors(count: number, dimension: number): Float32Array[] {
    let state = 123456789;
    const random = () => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 4294967296;
    };
    return Array.from({ length: count }, (_, index) => {
        const cluster = index % 5;
        return Float32Array.from({ length: dimension }, (_, component) => cluster * 0.3 + component * 0.01 + random() * 0.2);
    });
}

function randomVectors(count: number, dimension: number): Float32Array[] {
    let state = 987654321;
    const random = () => {
        state = (Math.imul(1103515245, state) + 12345) >>> 0;
        return state / 4294967296;
    };
    return Array.from({ length: count }, () => Float32Array.from({ length: dimension }, () => random() * 2 - 1));
}

describe('HNSWIndex', () => {
    it('serializes compact typed arrays and restores identical results', async () => {
        const vectors = deterministicVectors(200, 16);
        const index = new HNSWIndex(16, 'l2', { m: 8, efConstruction: 80, seed: 42 });
        await index.build(vectors.map((vector, id) => ({ id: String(id), vector })));
        const before = index.search(vectors[17], 10, 100);
        const snapshot = index.serialize();
        expect(snapshot.vectors).toBeInstanceOf(Float32Array);
        expect(snapshot.neighbors).toBeInstanceOf(Uint32Array);
        expect(snapshot.neighborOffsets).toBeInstanceOf(Uint32Array);
        const restored = HNSWIndex.deserialize(snapshot);
        expect(restored.search(vectors[17], 10, 100)).toEqual(before);
    });

    it('meets the deterministic recall@10 gate', async () => {
        const vectors = deterministicVectors(800, 24);
        const index = new HNSWIndex(24, 'l2', { m: 16, efConstruction: 120, seed: 99 });
        await index.build(vectors.map((vector, id) => ({ id: String(id), vector })));
        let overlap = 0;
        const queries = vectors.filter((_, index) => index % 79 === 0).slice(0, 10);
        for (const query of queries) {
            const exact = vectors
                .map((vector, id) => ({ id: String(id), score: metricScore('l2', query, vector) }))
                .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
                .slice(0, 10);
            const expected = new Set(exact.map((item) => item.id));
            overlap += index.search(query, 10, 100).filter((item) => expected.has(item.id)).length / 10;
        }
        expect(overlap / queries.length).toBeGreaterThanOrEqual(0.95);
    });

    it('meets recall@10 on deterministic random data', async () => {
        const vectors = randomVectors(1_000, 32);
        const queries = randomVectors(12, 32);
        const index = new HNSWIndex(32, 'l2', { m: 16, efConstruction: 200, seed: 123 });
        await index.build(vectors.map((vector, id) => ({ id: String(id), vector })));
        let overlap = 0;
        for (const query of queries) {
            const expected = new Set(
                vectors
                    .map((vector, id) => ({ id: String(id), score: metricScore('l2', query, vector) }))
                    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
                    .slice(0, 10)
                    .map(({ id }) => id)
            );
            overlap += index.search(query, 10, 100).filter(({ id }) => expected.has(id)).length / 10;
        }
        expect(overlap / queries.length).toBeGreaterThanOrEqual(0.95);
    });

    it('never returns tombstoned ids', async () => {
        const vectors = deterministicVectors(30, 8);
        const index = new HNSWIndex(8, 'dot', { m: 6, efConstruction: 40, seed: 5 });
        await index.build(vectors.map((vector, id) => ({ id: String(id), vector })));
        index.markDeleted('0');
        expect(index.search(vectors[0], 30, 100).map((item) => item.id)).not.toContain('0');
    });
});
