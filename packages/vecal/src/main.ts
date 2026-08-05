import { VectorDB, type Metadata } from './index.js';

interface DemoMetadata extends Metadata {
    title: string;
    category: string;
}

const documents = [
    { title: 'Browser-local semantic search', category: 'guide', vector: new Float32Array([0.92, 0.12, 0.08]) },
    { title: 'Persistent HNSW indexes', category: 'guide', vector: new Float32Array([0.78, 0.31, 0.11]) },
    { title: 'Metadata filtering', category: 'api', vector: new Float32Array([0.2, 0.88, 0.24]) },
];

const status = document.getElementById('status')!;
const results = document.getElementById('results')!;
const searchButton = document.getElementById('search') as HTMLButtonElement;

async function start() {
    const db = await VectorDB.open<DemoMetadata>({
        name: 'vecal-demo',
        dimension: 3,
        metric: 'cosine',
        workerUrl: new URL('./worker.ts', import.meta.url),
    });
    if ((await db.count()) === 0) {
        await db.addMany(
            documents.map((document) => ({
                vector: document.vector,
                metadata: { title: document.title, category: document.category },
            }))
        );
    }
    await db.ensureIndex({ type: 'hnsw' });
    status.textContent = `Ready: ${await db.count()} local documents`;

    searchButton.onclick = async () => {
        const query = new Float32Array([0.9, 0.2, 0.1]);
        const matches = await db.search(query, { k: 3, strategy: 'auto' });
        results.replaceChildren(
            ...matches.map((match) => {
                const item = document.createElement('li');
                item.textContent = `${match.metadata?.title} — ${match.score.toFixed(3)}`;
                return item;
            })
        );
    };
}

void start().catch((error: unknown) => {
    status.textContent = error instanceof Error ? error.message : String(error);
});
