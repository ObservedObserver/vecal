# vecal

![NPM Version](https://img.shields.io/npm/v/vecal)

Vector database in browser based on IndexedDB.

## Features

- CRUD operations for vectors
- Similarity search using cosine or L2 distance
- Optional LSH based index with approximate nearest neighbour (ANN) search

## Installation

```bash
npm install vecal
# or
yarn add vecal
```

## Basic Usage

```ts
import { VectorDB } from 'vecal';

const db = new VectorDB({ dbName: 'example', dimension: 3 });

const id = await db.add(new Float32Array([0.9, 0.1, 0.1]), { label: 'Apple' });

const results = await db.search(new Float32Array([0.85, 0.2, 0.15]), 2);
console.log(results);
```

### Using the LSH index

```ts
await db.buildIndex(8);
const ann = await db.annSearch(new Float32Array([0.85, 0.2, 0.15]), 2);
```

### Closing the database

```ts
await db.close();
```

## API Reference

### `new VectorDB(config: VectorDBConfig)`
Creates a database instance. `config` fields:
- `dbName` – name of the IndexedDB database.
- `dimension` – length of the stored vectors.
- `storeName` – optional object store name (defaults to `"vectors"`).

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

### `search(query, k?, distanceType?) => Promise<SearchResult[]>`
Exact similarity search. `distanceType` can be `"cosine"` or `"l2"`.

### `annSearch(query, k?, radius?, distanceType?) => Promise<SearchResult[]>`
Approximate nearest neighbour search using the LSH index. The index is built lazily when first needed.

### `close() => Promise<void>`
Close the underlying IndexedDB connection.

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
