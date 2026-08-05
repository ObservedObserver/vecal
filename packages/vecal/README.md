# Vecal

Vecal is a small, browser-only vector database backed by IndexedDB. The `1.0.0-rc.1` line provides Exact search and a persistent, Worker-hosted HNSW index with no runtime dependencies.

```ts
import { VectorDB } from 'vecal';

const db = await VectorDB.open({
    name: 'documents',
    dimension: 384,
    metric: 'cosine',
});

await db.add({
    vector: embedding,
    metadata: { title: 'Browser-local search', section: 'guide' },
});

await db.ensureIndex({ type: 'hnsw' });

const matches = await db.search(queryEmbedding, {
    k: 10,
    strategy: 'auto',
    where: { section: { $eq: 'guide' } },
});
```

Vecal requires IndexedDB, `crypto.randomUUID()`, and Dedicated Worker support. It is safe to import during SSR, but `VectorDB.open()` must run in a browser. Use the `workerUrl` or `workerFactory` open option when CSP or a bundler cannot use the adjacent default module Worker.

See the [repository documentation](https://github.com/ObservedObserver/vecal) for the complete API, index lifecycle, filtering semantics, and browser support policy.
