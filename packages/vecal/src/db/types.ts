export interface VectorDBConfig {
    dbName: string;
    dimension: number;
    storeName?: string;
}

export interface VectorEntry {
    id: string;
    vector: Float32Array;
    metadata?: Record<string, any>;
    norm?: number;
}

export interface SearchResult {
    id: string;
    score: number;
    metadata?: Record<string, any>;
}

export type DistanceType = 'cosine' | 'l2';
