import { HNSWIndex } from './hnsw-index';

interface BuildMessage {
    type: 'build';
    dim: number;
    m: number;
    efConstruction: number;
    entries: { id: string; vector: Float32Array }[];
}

self.onmessage = (e: MessageEvent<BuildMessage>) => {
    const data = e.data;
    if (data.type === 'build') {
        const index = new HNSWIndex(data.dim, data.m, data.efConstruction);
        index.build(data.entries);
        // post back simple serialized index
        (self as any).postMessage({ type: 'done', index }, []);
    }
};
