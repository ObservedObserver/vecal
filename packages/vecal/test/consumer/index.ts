import {
    VectorDB,
    type Metadata,
    type SearchResult,
    type VectorDBOpenOptions,
    type Where,
} from 'vecal';

interface DocumentMetadata extends Metadata {
    title: string;
    rating: number;
}

const options: VectorDBOpenOptions = { name: 'consumer', dimension: 3, metric: 'cosine' };
const where: Where<DocumentMetadata> = { rating: { $gte: 4 } };

async function consume(): Promise<SearchResult<DocumentMetadata>[]> {
    const database = await VectorDB.open<DocumentMetadata>(options);
    await database.add({ vector: new Float32Array([1, 0, 0]), metadata: { title: 'Example', rating: 5 } });
    await database.ensureIndex({ type: 'hnsw' });
    return database.search(new Float32Array([1, 0, 0]), { strategy: 'auto', where });
}

void consume;
