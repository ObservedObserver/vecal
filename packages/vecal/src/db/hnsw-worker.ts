import { HNSWIndex, HNSWSerializedIndex } from './hnsw-index';

interface BuildMessage {
    type: 'build';
    dim: number;
    m: number;
    efConstruction: number;
    entries: { id: string; vector: Float32Array }[];
}

interface DoneMessage {
    type: 'done';
    index: HNSWSerializedIndex;
}

interface ErrorMessage {
    type: 'error';
    message: string;
}

self.onmessage = (e: MessageEvent<BuildMessage>) => {
    const data = e.data;
    if (data.type === 'build') {
        try {
            const index = new HNSWIndex(data.dim, data.m, data.efConstruction);
            index.build(data.entries);
            (self as any).postMessage({
                type: 'done',
                index: index.serialize(),
            } as DoneMessage);
        } catch (error) {
            (self as any).postMessage({
                type: 'error',
                message: error instanceof Error ? error.message : 'Failed to build HNSW index',
            } as ErrorMessage);
        }
    }
};
