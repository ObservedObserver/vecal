import { VectorDB, type Metadata, type Where } from 'vecal';

interface NoteMetadata extends Metadata {
    title: string;
    rating: number;
}

const where: Where<NoteMetadata> = { rating: { $gte: 4 } };

async function open() {
    const db = await VectorDB.open<NoteMetadata>({ name: 'types', dimension: 3, metric: 'cosine' });
    return db.search(new Float32Array([1, 0, 0]), { where });
}

void open;
