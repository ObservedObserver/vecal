import { VectorDBConfig, VectorEntry, SearchResult, DistanceType, SearchOptions, MetadataFilter } from './types';
import { LSHIndex } from './lsh-index';
import { IVFFlatIndex } from './ivfflat-index';
import { HNSWIndex, HNSWSerializedIndex } from './hnsw-index';
import { LRUCache } from './memory-cache';
import {
    euclideanDistance,
    manhattanDistance,
    dotProduct as vectorDotProduct,
    hammingDistance,
    minkowskiDistance,
} from '../lib/similarity';
import { generateId } from '../utils/id';
import { validateDimension } from '../utils/validation';

export class VectorDB {
    private dbName: string;
    private dimension: number;
    private storeName: string;
    private dbPromise: Promise<IDBDatabase>;
    private db?: IDBDatabase;
    private index?: LSHIndex;
    private ivf?: IVFFlatIndex;
    private hnsw?: HNSWIndex;
    private cache: LRUCache<string, VectorEntry>;
    private defaultDistance: DistanceType;
    private minkowskiP: number;
    private hnswDirty: boolean;
    private isClosed: boolean;
    private entryCount: number | null;

    constructor(config: VectorDBConfig) {
        this.dbName = config.dbName;
        this.dimension = config.dimension;
        this.storeName = config.storeName || 'vectors';
        this.defaultDistance = config.distanceType || 'cosine';
        this.minkowskiP = config.minkowskiP || 3;
        this.dbPromise = this.initDB();
        this.cache = new LRUCache<string, VectorEntry>(0);
        this.hnswDirty = false;
        this.isClosed = false;
        this.entryCount = null;
    }

    private setCacheCapacity(entryCount: number): void {
        const cap = Math.max(Math.floor(entryCount * 0.2), 1);
        this.cache.setMaxSize(cap);
    }

    private async fetchEntryCount(): Promise<number> {
        const db = await this.dbPromise;
        if (this.isClosed) return 0;
        return new Promise<number>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const req = store.count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    private async updateCacheCapacity(knownCount?: number) {
        if (this.isClosed) return;
        try {
            if (typeof knownCount === 'number') {
                this.entryCount = Math.max(knownCount, 0);
            } else if (this.entryCount === null) {
                this.entryCount = await this.fetchEntryCount();
            }

            this.setCacheCapacity(this.entryCount ?? 0);
        } catch {
            // ignore cache updates if DB is no longer available
        }
    }

    private initDB(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
                    store.createIndex('vector', 'vector', { unique: false });
                }
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve(request.result);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async close(): Promise<void> {
        if (this.isClosed) return;
        const db = await this.dbPromise;
        db.close();
        this.db = undefined;
        this.index = undefined;
        this.ivf = undefined;
        this.hnsw = undefined;
        this.hnswDirty = false;
        this.entryCount = null;
        this.cache.clear();
        this.isClosed = true;
    }

    private ensureOpen(): void {
        if (this.isClosed) {
            throw new Error('Database is closed');
        }
    }

    private normalizeVector(vector: Float32Array | ArrayLike<number> | Record<string, number>): Float32Array {
        if (vector instanceof Float32Array) {
            return vector;
        }

        const maybeLength = (vector as ArrayLike<number>)?.length;
        if (typeof maybeLength === 'number') {
            return Float32Array.from(Array.from(vector as ArrayLike<number>));
        }

        return Float32Array.from(Object.values(vector as Record<string, number>));
    }

    private normalizeEntry(entry: VectorEntry): VectorEntry {
        const normalizedVector = this.normalizeVector(entry.vector as unknown as Float32Array | ArrayLike<number> | Record<string, number>);
        const needsNorm = typeof entry.norm !== 'number';

        if (normalizedVector === entry.vector && !needsNorm) {
            return entry;
        }

        return {
            ...entry,
            vector: normalizedVector,
            norm: needsNorm ? this.calculateNorm(normalizedVector) : entry.norm,
        };
    }

    async add(vector: Float32Array, metadata?: Record<string, any>): Promise<string> {
        this.ensureOpen();
        validateDimension(vector, this.dimension);
        const id = generateId();
        const entry: VectorEntry = {
            id,
            vector,
            metadata,
            norm: this.calculateNorm(vector),
        };

        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            store.add(entry);
            tx.oncomplete = async () => {
                if (this.index) {
                    this.index.add(id, vector);
                }
                if (this.ivf) {
                    this.ivf.add(id, vector);
                }
                if (this.hnsw) {
                    this.hnswDirty = true;
                }
                this.cache.set(id, entry);
                const nextCount = this.entryCount === null ? undefined : this.entryCount + 1;
                await this.updateCacheCapacity(nextCount);
                resolve(id);
            };
            tx.onerror = () => reject(tx.error);
        });
    }

    async get(id: string): Promise<VectorEntry | undefined> {
        this.ensureOpen();
        const cached = this.cache.get(id);
        if (cached) return cached;
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.get(id);

            request.onsuccess = () => {
                const res = request.result as VectorEntry | undefined;
                if (!res) {
                    resolve(undefined);
                    return;
                }

                const normalized = this.normalizeEntry(res);
                this.cache.set(id, normalized);
                resolve(normalized);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async update(id: string, update: Partial<Omit<VectorEntry, 'id'>>): Promise<void> {
        this.ensureOpen();
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);

            const getReq = store.get(id);
            getReq.onsuccess = () => {
                try {
                    const rawCurrent = getReq.result as VectorEntry | undefined;
                    if (!rawCurrent) {
                        reject(new Error('Entry not found'));
                        return;
                    }

                    const current = this.normalizeEntry(rawCurrent);
                    const hasVectorUpdate = update.vector !== undefined;
                    const updatedVector = hasVectorUpdate
                        ? this.normalizeVector(update.vector as Float32Array | ArrayLike<number> | Record<string, number>)
                        : current.vector;

                    validateDimension(updatedVector, this.dimension);

                    const updatedEntry: VectorEntry = {
                        ...current,
                        ...update,
                        id,
                        vector: updatedVector,
                        norm: this.calculateNorm(updatedVector),
                    };

                    store.put(updatedEntry);
                    if (hasVectorUpdate && this.index) {
                        this.index.remove(id, current.vector);
                        this.index.add(id, updatedEntry.vector);
                    }
                    if (hasVectorUpdate && this.ivf) {
                        this.ivf.remove(id, current.vector);
                        this.ivf.add(id, updatedEntry.vector);
                    }
                    if (hasVectorUpdate && this.hnsw) {
                        this.hnswDirty = true;
                    }
                    this.cache.set(id, updatedEntry);
                } catch (error) {
                    reject(error);
                }
            };
            getReq.onerror = () => reject(getReq.error);

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async delete(id: string): Promise<void> {
        this.ensureOpen();
        const db = await this.dbPromise;
        const entry = await this.get(id);
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            store.delete(id);
            tx.oncomplete = async () => {
                if (this.index && entry) {
                    this.index.remove(id, entry.vector);
                }
                if (this.ivf && entry) {
                    this.ivf.remove(id, entry.vector);
                }
                if (this.hnsw) {
                    this.hnswDirty = true;
                }
                this.cache.delete(id);
                const nextCount = entry && this.entryCount !== null ? Math.max(this.entryCount - 1, 0) : undefined;
                await this.updateCacheCapacity(nextCount);
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        });
    }

    private async getAllEntries(): Promise<VectorEntry[]> {
        this.ensureOpen();
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.getAll();

            request.onsuccess = () => {
                const entries = (request.result as VectorEntry[]).map((entry) => this.normalizeEntry(entry));
                this.entryCount = entries.length;
                resolve(entries);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async buildIndex(numHashes: number = 10): Promise<void> {
        this.ensureOpen();
        const entries = await this.getAllEntries();
        const index = new LSHIndex(this.dimension, numHashes);
        for (const entry of entries) {
            index.add(entry.id, entry.vector);
        }
        this.index = index;
    }

    async buildIVFFlatIndex(nlist = 256, nprobe = 8): Promise<void> {
        this.ensureOpen();
        const entries = await this.getAllEntries();
        const ivf = new IVFFlatIndex(this.dimension, nlist, nprobe);
        ivf.build(entries.map((e) => ({ id: e.id, vector: e.vector })));
        this.ivf = ivf;
        await this.updateCacheCapacity(entries.length);
    }

    async buildHNSWIndex(m = 16, efConstruction = 200): Promise<void> {
        this.ensureOpen();
        const entries = await this.getAllEntries();
        if (typeof Worker !== 'undefined') {
            try {
                const worker = new Worker(new URL('./hnsw-worker.ts', import.meta.url), { type: 'module' });
                const result: Promise<HNSWSerializedIndex> = new Promise((resolve, reject) => {
                    worker.onmessage = (ev: MessageEvent<{ type: 'done'; index: HNSWSerializedIndex } | { type: 'error'; message: string }>) => {
                        const message = ev.data;
                        if (message.type === 'done') {
                            resolve(message.index);
                        } else {
                            reject(new Error(message.message));
                        }
                        worker.terminate();
                    };
                    worker.onerror = (event) => {
                        reject(new Error(event.message || 'Failed to build HNSW index in worker'));
                        worker.terminate();
                    };
                });
                worker.postMessage({ type: 'build', dim: this.dimension, m, efConstruction, entries });
                this.hnsw = HNSWIndex.deserialize(await result);
            } catch {
                const hnsw = new HNSWIndex(this.dimension, m, efConstruction);
                hnsw.build(entries.map((e) => ({ id: e.id, vector: e.vector })));
                this.hnsw = hnsw;
            }
        } else {
            const hnsw = new HNSWIndex(this.dimension, m, efConstruction);
            hnsw.build(entries.map((e) => ({ id: e.id, vector: e.vector })));
            this.hnsw = hnsw;
        }
        this.hnswDirty = false;
        await this.updateCacheCapacity(entries.length);
    }

    private matchesFilter(entry: VectorEntry, filter?: MetadataFilter): boolean {
        if (!filter) return true;
        if (typeof filter === 'function') {
            return filter(entry);
        }

        const metadata = entry.metadata || {};
        for (const [key, expected] of Object.entries(filter)) {
            const actual = metadata[key];
            if (Array.isArray(expected)) {
                if (!expected.some((value) => Object.is(value, actual))) {
                    return false;
                }
                continue;
            }
            if (!Object.is(actual, expected)) {
                return false;
            }
        }
        return true;
    }

    private calculateScore(query: Float32Array, entry: VectorEntry, distanceType: DistanceType, queryNorm: number): number {
        if (distanceType === 'cosine') {
            const dot = vectorDotProduct(query, entry.vector);
            return queryNorm === 0 || !entry.norm ? 0 : dot / (queryNorm * (entry.norm || 0));
        }
        if (distanceType === 'l2') {
            return -euclideanDistance(query, entry.vector);
        }
        if (distanceType === 'l1') {
            return -manhattanDistance(query, entry.vector);
        }
        if (distanceType === 'dot') {
            return vectorDotProduct(query, entry.vector);
        }
        if (distanceType === 'hamming') {
            return -hammingDistance(query, entry.vector);
        }
        return -minkowskiDistance(query, entry.vector, this.minkowskiP);
    }

    async search(
        query: Float32Array,
        k: number = 5,
        distanceType?: DistanceType,
        options: SearchOptions = {}
    ): Promise<SearchResult[]> {
        this.ensureOpen();
        validateDimension(query, this.dimension);
        const resolvedDistanceType = distanceType || this.defaultDistance;
        const db = await this.dbPromise;

        const allEntries = await new Promise<VectorEntry[]>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.getAll();

            request.onsuccess = () => resolve((request.result as VectorEntry[]).map((entry) => this.normalizeEntry(entry)));
            request.onerror = () => reject(request.error);
        });

        const results: SearchResult[] = [];
        const queryNorm = resolvedDistanceType === 'cosine' ? this.calculateNorm(query) : 0;

        for (const entry of allEntries) {
            if (!this.matchesFilter(entry, options.filter)) {
                continue;
            }

            const score = this.calculateScore(query, entry, resolvedDistanceType, queryNorm);
            if (typeof options.minScore === 'number' && score < options.minScore) {
                continue;
            }
            results.push({
                id: entry.id,
                score,
                metadata: entry.metadata,
            });
        }

        return results.sort((a, b) => b.score - a.score).slice(0, k);
    }

    async ivfSearch(query: Float32Array, k = 5, options: SearchOptions = {}): Promise<SearchResult[]> {
        this.ensureOpen();
        validateDimension(query, this.dimension);
        if (!this.ivf) {
            await this.buildIVFFlatIndex();
        }
        const candidateK = options.filter || typeof options.minScore === 'number' ? Math.max(k * 5, k + 10) : k;
        const results = this.ivf!.search(query, candidateK);
        const entries: SearchResult[] = [];
        for (const r of results) {
            const e = await this.get(r.id);
            if (e) {
                if (!this.matchesFilter(e, options.filter)) {
                    continue;
                }
                const score = -r.distance;
                if (typeof options.minScore === 'number' && score < options.minScore) {
                    continue;
                }
                entries.push({ id: r.id, score, metadata: e.metadata });
            }
        }
        return entries.sort((a, b) => b.score - a.score).slice(0, k);
    }

    async hnswSearch(query: Float32Array, k = 5, efSearch = 64, options: SearchOptions = {}): Promise<SearchResult[]> {
        this.ensureOpen();
        validateDimension(query, this.dimension);
        if (!this.hnsw || this.hnswDirty) {
            await this.buildHNSWIndex();
        }
        const candidateK = options.filter || typeof options.minScore === 'number' ? Math.max(k * 5, k + 10) : k;
        const results = this.hnsw!.search(query, candidateK, efSearch);
        const formatted: SearchResult[] = [];
        for (const r of results) {
            const e = await this.get(r.id);
            if (e) {
                if (!this.matchesFilter(e, options.filter)) {
                    continue;
                }
                const score = -r.distance;
                if (typeof options.minScore === 'number' && score < options.minScore) {
                    continue;
                }
                formatted.push({ id: r.id, score, metadata: e.metadata });
            }
        }
        return formatted.sort((a, b) => b.score - a.score).slice(0, k);
    }

    async annSearch(
        query: Float32Array,
        k: number = 5,
        radius: number = 1,
        distanceType?: DistanceType,
        options: SearchOptions = {}
    ): Promise<SearchResult[]> {
        this.ensureOpen();
        validateDimension(query, this.dimension);
        const resolvedDistanceType = distanceType || this.defaultDistance;
        if (!this.index) {
            await this.buildIndex();
        }
        const candidateIds = this.index ? this.index.query(query, radius) : [];
        const entries: VectorEntry[] = [];
        for (const id of candidateIds) {
            const e = await this.get(id);
            if (e) entries.push(e);
        }
        // fallback to full scan when candidate set is too small
        if (entries.length < k) {
            const all = await this.getAllEntries();
            const existingIds = new Set(entries.map((entry) => entry.id));
            for (const entry of all) {
                if (!existingIds.has(entry.id)) {
                    entries.push(entry);
                }
            }
        }

        const results: SearchResult[] = [];
        const queryNorm = resolvedDistanceType === 'cosine' ? this.calculateNorm(query) : 0;
        for (const entry of entries) {
            if (!this.matchesFilter(entry, options.filter)) {
                continue;
            }
            const score = this.calculateScore(query, entry, resolvedDistanceType, queryNorm);
            if (typeof options.minScore === 'number' && score < options.minScore) {
                continue;
            }
            results.push({ id: entry.id, score, metadata: entry.metadata });
        }
        return results.sort((a, b) => b.score - a.score).slice(0, k);
    }

    private calculateNorm(vector: Float32Array): number {
        let sum = 0;
        for (let i = 0; i < vector.length; i++) {
            const value = vector[i];
            sum += value * value;
        }
        return Math.sqrt(sum);
    }

}
