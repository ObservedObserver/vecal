# Vecal

Vecal is an ESM-only, browser-local vector database. IndexedDB is the source of truth and a dedicated module Worker performs storage, exact search, HNSW construction, and approximate search away from the main thread.

The current package is the `1.0.0-rc.1` release candidate. It intentionally has no runtime dependencies and does not include embedding generation, cloud sync, collections, or server-side execution.

## Install

```bash
npm install vecal@1.0.0-rc.1
# or
yarn add vecal@1.0.0-rc.1
```

## Quick start

```ts
import { VectorDB, type Metadata } from 'vecal';

interface DocumentMetadata extends Metadata {
    title: string;
    section: 'guide' | 'api';
}

const db = await VectorDB.open<DocumentMetadata>({
    name: 'documents',
    dimension: 3,
    metric: 'cosine',
});

await db.addMany([
    {
        id: 'indexing',
        vector: new Float32Array([0.92, 0.1, 0.04]),
        metadata: { title: 'Vector indexing', section: 'guide' },
    },
    {
        id: 'api',
        vector: new Float32Array([0.2, 0.84, 0.11]),
        metadata: { title: 'API reference', section: 'api' },
    },
]);

await db.ensureIndex({ type: 'hnsw', m: 16, efConstruction: 200 });

const results = await db.search(new Float32Array([0.9, 0.12, 0.03]), {
    k: 10,
    strategy: 'auto',
    efSearch: 100,
    where: { section: { $eq: 'guide' } },
    minScore: 0.4,
});

await db.close();
```

## Core guarantees

- Stable metrics: `cosine`, `l2`, and `dot`. Scores always sort higher-is-better; L2 returns negative Euclidean distance and equal scores sort by ID.
- `strategy: 'auto'` uses a ready HNSW index and otherwise runs exact search. Explicit HNSW search never builds an index implicitly.
- Exact search streams an IndexedDB cursor into a bounded top-k heap rather than loading and sorting the full database.
- `addMany()` and `deleteMany()` use one IndexedDB transaction. Duplicate IDs make `addMany()` roll back as a unit.
- HNSW snapshots persist in IndexedDB. A mismatched revision makes the snapshot stale without affecting stored entries.
- Every public operation checks the authoritative revision, so another tab's committed writes are visible at the next operation boundary.
- Metadata is JSON data. Filters support top-level AND conditions with `$eq`, `$in`, `$gt`, `$gte`, `$lt`, and `$lte`.
- Filtered HNSW search expands its candidate set and uses a complete exact fallback if it still cannot fill `k`.

## Runtime and bundlers

Importing Vecal during SSR is safe, but `VectorDB.open()` requires IndexedDB and Dedicated Worker support. The default worker is created with:

```ts
new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
```

For CSP rules or unusual bundlers, provide `workerUrl` or `workerFactory` to `VectorDB.open()`. Your CSP must allow module workers from that URL.

Vecal targets the latest two Chrome, Firefox, and Safari releases. The intended 1.0 scale envelope is 50k vectors at 384 dimensions or 10k vectors at 1536 dimensions; validate representative data and HNSW settings on your target hardware before shipping.

## Development

This Yarn monorepo contains the library in `packages/vecal` and documentation in `packages/docs`.

```bash
yarn install
yarn test
yarn build
yarn workspace vecal test:browser
```

See the [documentation](./packages/docs/content/docs/index.mdx) and [API reference](./packages/docs/content/docs/api-reference.mdx) for the full lifecycle, error classes, persistence semantics, and limitations.
