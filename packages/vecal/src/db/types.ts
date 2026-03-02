export interface VectorDBConfig {
    dbName: string;
    dimension: number;
    storeName?: string;
    distanceType?: DistanceType;
    minkowskiP?: number;
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

export type DistanceType = 'cosine' | 'l2' | 'l1' | 'dot' | 'hamming' | 'minkowski';

export type MetadataFilter = Record<string, unknown> | ((entry: VectorEntry) => boolean);

export interface SearchOptions {
    filter?: MetadataFilter;
    minScore?: number;
}
