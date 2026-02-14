# vecal

![NPM Version](https://img.shields.io/npm/v/vecal)

`vecal` is a browser vector database built on top of IndexedDB.

## Features

- CRUD operations for vectors
- Similarity search using multiple distance metrics
- Optional ANN indexes: LSH, IVFFlat, and HNSW
- In-memory index lifecycle (indexes are rebuilt after refresh)

## Installation

```bash
npm install vecal
# or
yarn add vecal
```

## Quick Start

```ts
import { VectorDB } from 'vecal';

const db = new VectorDB({
  dbName: 'products-db',
  dimension: 3,
  distanceType: 'cosine',
});

await db.add(new Float32Array([0.9, 0.1, 0.1]), { label: 'Apple' });
await db.add(new Float32Array([0.1, 0.9, 0.1]), { label: 'Banana' });
await db.add(new Float32Array([0.1, 0.1, 0.9]), { label: 'Cherry' });

const results = await db.search(new Float32Array([0.85, 0.2, 0.15]), 2);
console.log(results);
```

## Common Usage Examples

### CRUD operations

```ts
import { VectorDB } from 'vecal';

const db = new VectorDB({ dbName: 'example-crud', dimension: 3 });

const id = await db.add(new Float32Array([0.9, 0.1, 0.1]), { label: 'Apple' });
const entry = await db.get(id);
console.log(entry?.metadata?.label); // Apple

await db.update(id, {
  metadata: { label: 'Green Apple' },
});

await db.delete(id);
```

### Exact search with different distance metrics

```ts
const db = new VectorDB({
  dbName: 'example-distance',
  dimension: 3,
  distanceType: 'cosine',
});

await db.add(new Float32Array([0.9, 0.1, 0.1]), { label: 'Apple' });
await db.add(new Float32Array([0.1, 0.9, 0.1]), { label: 'Banana' });

const query = new Float32Array([0.85, 0.2, 0.15]);

const cosineTop = await db.search(query, 1, 'cosine');
const l2Top = await db.search(query, 1, 'l2');
const dotTop = await db.search(query, 1, 'dot');

console.log(cosineTop[0], l2Top[0], dotTop[0]);
```

### ANN search with LSH

```ts
const db = new VectorDB({ dbName: 'example-lsh', dimension: 3 });

await db.add(new Float32Array([0.9, 0.1, 0.1]), { label: 'Apple' });
await db.add(new Float32Array([0.1, 0.9, 0.1]), { label: 'Banana' });
await db.add(new Float32Array([0.1, 0.1, 0.9]), { label: 'Cherry' });

await db.buildIndex(8);
const results = await db.annSearch(new Float32Array([0.85, 0.2, 0.15]), 2, 1);
console.log(results);
```

### ANN search with IVFFlat

```ts
const db = new VectorDB({ dbName: 'example-ivf', dimension: 3 });

await db.add(new Float32Array([0.9, 0.1, 0.1]), { label: 'Apple' });
await db.add(new Float32Array([0.1, 0.9, 0.1]), { label: 'Banana' });
await db.add(new Float32Array([0.1, 0.1, 0.9]), { label: 'Cherry' });

await db.buildIVFFlatIndex(64, 8);
const results = await db.ivfSearch(new Float32Array([0.85, 0.2, 0.15]), 2);
console.log(results);
```

### ANN search with HNSW

```ts
const db = new VectorDB({ dbName: 'example-hnsw', dimension: 3 });

await db.add(new Float32Array([0.9, 0.1, 0.1]), { label: 'Apple' });
await db.add(new Float32Array([0.1, 0.9, 0.1]), { label: 'Banana' });
await db.add(new Float32Array([0.1, 0.1, 0.9]), { label: 'Cherry' });

await db.buildHNSWIndex(16, 200);

// Higher efSearch usually gives better recall but costs more compute.
const fastResults = await db.hnswSearch(new Float32Array([0.85, 0.2, 0.15]), 2, 32);
const highRecallResults = await db.hnswSearch(new Float32Array([0.85, 0.2, 0.15]), 2, 128);

console.log(fastResults, highRecallResults);
```

### Close lifecycle

```ts
const db = new VectorDB({ dbName: 'example-close', dimension: 3 });
await db.close();

try {
  await db.search(new Float32Array([0.1, 0.2, 0.3]), 1);
} catch (error) {
  console.error(error); // Error: Database is closed
}
```

## API Reference

### `new VectorDB(config: VectorDBConfig)`
Creates a database instance. `config` fields:
- `dbName` – name of the IndexedDB database.
- `dimension` – length of the stored vectors.
- `storeName` – optional object store name (defaults to `"vectors"`).
- `distanceType` – optional default distance metric.
- `minkowskiP` – power parameter when using Minkowski distance (default `3`).

### `add(vector, metadata?) => Promise<string>`
Add a vector with optional metadata. Returns the generated id.

### `get(id) => Promise<VectorEntry | undefined>`
Retrieve a stored entry.

### `update(id, update) => Promise<void>`
Partially update an entry.

### `delete(id) => Promise<void>`
Remove an entry from the database.

### `buildIndex(numHashes?) => Promise<void>`
Build an LSH index from all entries. `numHashes` controls the number of hyperplanes (default `10`).

### `buildIVFFlatIndex(nlist?, nprobe?) => Promise<void>`
Build an IVFFlat index from all entries. `nlist` is the number of clusters (default `256`) and `nprobe` is the number of probed clusters at query time (default `8`).

### `buildHNSWIndex(m?, efConstruction?) => Promise<void>`
Build a graph-based HNSW index from all entries. If Web Workers are available, building is attempted in a worker with a synchronous fallback path.

### `search(query, k?, distanceType?) => Promise<SearchResult[]>`
Exact similarity search. `distanceType` can be `"cosine"`, `"l2"`, `"l1"`, `"dot"`, `"hamming"`, or `"minkowski"`.

### `annSearch(query, k?, radius?, distanceType?) => Promise<SearchResult[]>`
Approximate nearest neighbour search using the LSH index. The index is built lazily when first needed. `distanceType` uses the same options as `search`.

### `ivfSearch(query, k?) => Promise<SearchResult[]>`
Approximate nearest neighbour search using the IVFFlat index. The index is built lazily when first needed.

### `hnswSearch(query, k?, efSearch?) => Promise<SearchResult[]>`
Approximate nearest neighbour search using the HNSW index. The index is built lazily when first needed. `efSearch` controls the search candidate queue size (default `64`), where larger values generally improve recall with higher query cost.

### `close() => Promise<void>`
Close the underlying IndexedDB connection.

After calling `close()`, any further operation will throw `Database is closed`.

## Index persistence behavior

ANN indexes (LSH, IVFFlat, HNSW) are in-memory structures. Stored vectors remain in IndexedDB, but indexes are rebuilt on demand after page refresh or new session start.

## Choosing a search method

- Use `search` for exact results on small or medium datasets.
- Use `annSearch` (LSH) for very lightweight approximate search.
- Use `ivfSearch` for centroid-based approximate search.
- Use `hnswSearch` for higher recall ANN and tune `efSearch` for speed/quality trade-off.

### Types
- `VectorDBConfig`
- `VectorEntry`
- `SearchResult`
- `DistanceType`

## Tutorial: indexing text with OpenAI embeddings
The `src/main.ts` file in this repository demonstrates how to build a small Hacker News search tool. The high level steps are:
1. obtain an OpenAI API key;
2. fetch items to index;
3. convert each title to an embedding using the API;
4. create a `VectorDB` with the embedding dimension and store each vector;
5. run searches with `db.search` or `db.annSearch`.

Refer to the code for a full example.
