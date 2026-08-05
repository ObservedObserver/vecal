export type Metric = 'cosine' | 'l2' | 'dot';

export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue };
export type Metadata = Record<string, JSONValue>;

export interface WorkerLike {
    postMessage(message: unknown): void;
    terminate(): void;
    addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
    removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
}

export interface VectorDBOpenOptions {
    name: string;
    dimension: number;
    metric: Metric;
    workerUrl?: URL;
    workerFactory?: () => WorkerLike;
}

export interface VectorInput<M extends Metadata = Metadata> {
    id?: string;
    vector: Float32Array;
    metadata?: M;
}

export interface VectorRecord<M extends Metadata = Metadata> {
    id: string;
    vector: Float32Array;
    metadata?: M;
}

export interface VectorUpdate<M extends Metadata = Metadata> {
    vector?: Float32Array;
    metadata?: M;
}

export type ComparisonValue = JSONPrimitive;

export interface WhereOperator {
    $eq?: ComparisonValue;
    $in?: ComparisonValue[];
    $gt?: number | string;
    $gte?: number | string;
    $lt?: number | string;
    $lte?: number | string;
}

export type Where<M extends Metadata = Metadata> = Partial<
    Record<Extract<keyof M, string> | string, ComparisonValue | ComparisonValue[] | WhereOperator>
>;

export type SearchStrategy = 'auto' | 'exact' | 'hnsw';

export interface SearchOptions<M extends Metadata = Metadata> {
    k?: number;
    strategy?: SearchStrategy;
    efSearch?: number;
    where?: Where<M>;
    minScore?: number;
    signal?: AbortSignal;
}

export interface SearchResult<M extends Metadata = Metadata> {
    id: string;
    score: number;
    metadata?: M;
}

export interface IndexBuildProgress {
    completed: number;
    total: number;
    ratio: number;
}

export interface EnsureIndexOptions {
    type: 'hnsw';
    m?: number;
    efConstruction?: number;
    seed?: number;
    onProgress?: (progress: IndexBuildProgress) => void;
    signal?: AbortSignal;
}

export type IndexState = 'absent' | 'building' | 'ready' | 'stale' | 'closed';

export interface HNSWConfig {
    m: number;
    efConstruction: number;
    seed: number;
}

export interface IndexStatus {
    state: IndexState;
    revision: number;
    nodeCount: number;
    tombstoneRatio: number;
    config?: HNSWConfig;
}
