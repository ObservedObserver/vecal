import { VectorDB, type Metadata } from '../dist/index.js';

interface BenchmarkMetadata extends Metadata {
    cluster: number;
}

interface BenchmarkResult {
    count: number;
    dimension: number;
    buildMs: number;
    warmP95Ms: number;
    reopenMs: number;
    recallAt10: number;
    maxMainThreadLongTaskMs: number;
    measuredMemoryBytes?: number;
    browser: string;
    platform: string;
    hardwareConcurrency: number;
    deviceMemoryGiB?: number;
}

let database: VectorDB<BenchmarkMetadata> | undefined;

function percentile(values: number[], percentileValue: number): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function makeVector(dimension: number, cluster: number, random: () => number): Float32Array {
    const vector = new Float32Array(dimension);
    for (let component = 0; component < dimension; component++) {
        vector[component] = random() - 0.5 + (component % 16 === cluster ? 0.75 : 0);
    }
    return vector;
}

async function run(name: string, count: number, dimension: number): Promise<BenchmarkResult> {
    await database?.close();
    database = await VectorDB.open<BenchmarkMetadata>({ name, dimension, metric: 'cosine' });
    await database.clear();
    const random = generator(0xdecafbad);
    const queries: Float32Array[] = [];

    for (let offset = 0; offset < count; offset += 250) {
        const entries = [];
        for (let index = offset; index < Math.min(count, offset + 250); index++) {
            const cluster = index % 16;
            const vector = makeVector(dimension, cluster, random);
            if (queries.length < 10 && index % Math.max(1, Math.floor(count / 10)) === 0) queries.push(vector.slice());
            entries.push({ id: String(index).padStart(8, '0'), vector, metadata: { cluster } });
        }
        await database.addMany(entries);
    }

    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ type: 'longtask', buffered: false });
    const buildStart = performance.now();
    await database.ensureIndex({ type: 'hnsw', m: 16, efConstruction: 200, seed: 42 });
    const buildMs = performance.now() - buildStart;
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();

    const memory = performance as Performance & {
        measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    };
    const measuredMemoryBytes = (await memory.measureUserAgentSpecificMemory?.())?.bytes;

    let recallTotal = 0;
    for (const query of queries) {
        const exact = await database.search(query, { k: 10, strategy: 'exact' });
        const expected = new Set(exact.map(({ id }) => id));
        const approximate = await database.search(query, { k: 10, strategy: 'hnsw', efSearch: 100 });
        recallTotal += approximate.filter(({ id }) => expected.has(id)).length / 10;
    }

    const latencies: number[] = [];
    for (let iteration = 0; iteration < 110; iteration++) {
        const query = queries[iteration % queries.length];
        const start = performance.now();
        await database.search(query, { k: 10, strategy: 'hnsw', efSearch: 100 });
        if (iteration >= 10) latencies.push(performance.now() - start);
    }

    await database.close();
    const reopenStart = performance.now();
    database = await VectorDB.open<BenchmarkMetadata>({ name, dimension, metric: 'cosine' });
    const reopenMs = performance.now() - reopenStart;
    if (database.indexStatus().state !== 'ready') throw new Error('Benchmark snapshot did not restore as ready');

    const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
    const result = {
        count,
        dimension,
        buildMs,
        warmP95Ms: percentile(latencies, 0.95),
        reopenMs,
        recallAt10: recallTotal / queries.length,
        maxMainThreadLongTaskMs: Math.max(0, ...longTasks),
        measuredMemoryBytes,
        browser: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGiB: navigatorWithMemory.deviceMemory,
    };
    await database.close();
    database = undefined;
    return result;
}

declare global {
    interface Window {
        vecalBenchmark: { run: typeof run };
    }
}

window.vecalBenchmark = { run };
document.querySelector('#status')!.textContent = 'ready';
