import { VectorDB, type IndexStatus, type Metadata, type SearchResult } from '../dist/index.js';

interface HarnessMetadata extends Metadata {
    label: string;
    group?: string;
}

let database: VectorDB<HarnessMetadata> | undefined;

const harness = {
    async open(name: string, workerOverride = false): Promise<IndexStatus> {
        if (database) await database.close();
        database = await VectorDB.open<HarnessMetadata>({
            name,
            dimension: 3,
            metric: 'cosine',
            workerFactory: workerOverride
                ? () => new Worker(new URL('./custom-worker.ts', import.meta.url), { type: 'module' })
                : undefined,
        });
        return database.indexStatus();
    },
    async add(id: string, vector: number[], label: string, group?: string): Promise<string> {
        const metadata: HarnessMetadata = group === undefined ? { label } : { label, group };
        return database!.add({ id, vector: Float32Array.from(vector), metadata });
    },
    async updateLabel(id: string, label: string): Promise<void> {
        const current = await database!.get(id);
        const group = current?.metadata?.group;
        const metadata: HarnessMetadata = group === undefined ? { label } : { label, group };
        await database!.update(id, { metadata });
    },
    async getLabel(id: string): Promise<string | undefined> {
        return (await database!.get(id))?.metadata?.label;
    },
    async count(): Promise<number> {
        return database!.count();
    },
    async build(): Promise<IndexStatus> {
        await database!.ensureIndex({ type: 'hnsw', m: 8, efConstruction: 64, seed: 42 });
        return database!.indexStatus();
    },
    async search(vector: number[], group?: string): Promise<SearchResult<HarnessMetadata>[]> {
        return database!.search(Float32Array.from(vector), {
            k: 5,
            strategy: 'auto',
            where: group ? { group: { $eq: group } } : undefined,
        });
    },
    status(): IndexStatus {
        return database!.indexStatus();
    },
    async close(): Promise<void> {
        await database?.close();
    },
};

declare global {
    interface Window {
        vecalHarness: typeof harness;
    }
}

window.vecalHarness = harness;
document.getElementById('status')!.textContent = 'ready';
