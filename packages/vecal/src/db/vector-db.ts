import { VectorDBConfig, VectorEntry, SearchResult, DistanceType } from './types';
import { LSHIndex } from './lsh-index';
import { IVFFlatIndex } from './ivfflat-index';
import { HNSWIndex } from './hnsw-index';
import { LRUCache } from './memory-cache';
import {
    cosineSimilarity,
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

    constructor(config: VectorDBConfig) {
        this.dbName = config.dbName;
        this.dimension = config.dimension;
        this.storeName = config.storeName || 'vectors';
        this.defaultDistance = config.distanceType || 'cosine';
        this.minkowskiP = config.minkowskiP || 3;
        this.dbPromise = this.initDB();
        this.cache = new LRUCache<string, VectorEntry>(0);
    }

    private async updateCacheCapacity() {
        const db = await this.dbPromise;
        const count = await new Promise<number>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const req = store.count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        const cap = Math.max(Math.floor(count * 0.2), 1);
        this.cache.setMaxSize(cap);
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
        const db = await this.dbPromise;
        db.close();
    }

    async add(vector: Float32Array, metadata?: Record<string, any>): Promise<string> {
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
                this.cache.set(id, entry);
                await this.updateCacheCapacity();
                resolve(id);
            };
            tx.onerror = () => reject(tx.error);
        });
    }

    async get(id: string): Promise<VectorEntry | undefined> {
        const cached = this.cache.get(id);
        if (cached) return cached;
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.get(id);

            request.onsuccess = () => {
                const res = request.result as VectorEntry | undefined;
                if (res) this.cache.set(id, res);
                resolve(res);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async update(id: string, update: Partial<Omit<VectorEntry, 'id'>>): Promise<void> {
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);

            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const current = getReq.result as VectorEntry | undefined;
                if (!current) {
                    reject(new Error('Entry not found'));
                    return;
                }

                const updatedEntry: VectorEntry = {
                    ...current,
                    ...update,
                    id,
                };

                if (updatedEntry.vector) {
                    validateDimension(updatedEntry.vector, this.dimension);
                    updatedEntry.norm = this.calculateNorm(updatedEntry.vector);
                }

                store.put(updatedEntry);
                if (this.index) {
                    this.index.remove(id, current.vector);
                    this.index.add(id, updatedEntry.vector);
                }
                if (this.ivf) {
                    this.ivf.remove(id, current.vector);
                    this.ivf.add(id, updatedEntry.vector);
                }
                this.cache.set(id, updatedEntry);
            };
            getReq.onerror = () => reject(getReq.error);

            tx.oncomplete = async () => {
                await this.updateCacheCapacity();
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        });
    }

    async delete(id: string): Promise<void> {
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
                this.cache.delete(id);
                await this.updateCacheCapacity();
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        });
    }

    private async getAllEntries(): Promise<VectorEntry[]> {
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result as VectorEntry[]);
            request.onerror = () => reject(request.error);
        });
    }

    async buildIndex(numHashes: number = 10): Promise<void> {
        const entries = await this.getAllEntries();
        const index = new LSHIndex(this.dimension, numHashes);
        for (const entry of entries) {
            index.add(entry.id, entry.vector);
        }
        this.index = index;
    }

    async buildIVFFlatIndex(nlist = 256, nprobe = 8): Promise<void> {
        const entries = await this.getAllEntries();
        const ivf = new IVFFlatIndex(this.dimension, nlist, nprobe);
        ivf.build(entries.map((e) => ({ id: e.id, vector: e.vector })));
        this.ivf = ivf;
        await this.updateCacheCapacity();
    }

    async buildHNSWIndex(m = 16, efConstruction = 200): Promise<void> {
        const entries = await this.getAllEntries();
        if (typeof Worker !== 'undefined') {
            try {
                const worker = new Worker(new URL('./hnsw-worker.ts', import.meta.url), { type: 'module' });
                const result: Promise<HNSWIndex> = new Promise((resolve) => {
                    worker.onmessage = (ev) => {
                        const { index } = ev.data;
                        resolve(index);
                        worker.terminate();
                    };
                });
                worker.postMessage({ type: 'build', dim: this.dimension, m, efConstruction, entries });
                this.hnsw = await result;
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
        await this.updateCacheCapacity();
    }

    async search(query: Float32Array, k: number = 5, distanceType?: DistanceType): Promise<SearchResult[]> {
        validateDimension(query, this.dimension);
        distanceType = distanceType || this.defaultDistance;
        const db = await this.dbPromise;

        const allEntries = await new Promise<VectorEntry[]>((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        const results: SearchResult[] = [];
        const queryNorm = distanceType === 'cosine' ? this.calculateNorm(query) : 0;

        for (const entry of allEntries) {
            let score: number;

            if (distanceType === 'cosine') {
                const dot = vectorDotProduct(query, entry.vector);
                score = queryNorm === 0 || !entry.norm ? 0 : dot / (queryNorm * (entry.norm || 0));
            } else if (distanceType === 'l2') {
                score = -euclideanDistance(query, entry.vector);
            } else if (distanceType === 'l1') {
                score = -manhattanDistance(query, entry.vector);
            } else if (distanceType === 'dot') {
                score = vectorDotProduct(query, entry.vector);
            } else if (distanceType === 'hamming') {
                score = -hammingDistance(query, entry.vector);
            } else {
                score = -minkowskiDistance(query, entry.vector, this.minkowskiP);
            }

            results.push({
                id: entry.id,
                score,
                metadata: entry.metadata,
            });
        }

        return results.sort((a, b) => b.score - a.score).slice(0, k);
    }

    async ivfSearch(query: Float32Array, k = 5): Promise<SearchResult[]> {
        validateDimension(query, this.dimension);
        if (!this.ivf) {
            await this.buildIVFFlatIndex();
        }
        const results = this.ivf!.search(query, k);
        const entries: SearchResult[] = [];
        for (const r of results) {
            const e = await this.get(r.id);
            if (e) {
                entries.push({ id: r.id, score: -r.distance, metadata: e.metadata });
            }
        }
        return entries.sort((a, b) => b.score - a.score).slice(0, k);
    }

    async hnswSearch(query: Float32Array, k = 5): Promise<SearchResult[]> {
        validateDimension(query, this.dimension);
        if (!this.hnsw) {
            await this.buildHNSWIndex();
        }
        const results = this.hnsw!.search(query, k);
        const formatted: SearchResult[] = [];
        for (const r of results) {
            const e = await this.get(r.id);
            if (e) formatted.push({ id: r.id, score: -r.distance, metadata: e.metadata });
        }
        return formatted.sort((a, b) => b.score - a.score).slice(0, k);
    }

    async annSearch(
        query: Float32Array,
        k: number = 5,
        radius: number = 1,
        distanceType?: DistanceType
    ): Promise<SearchResult[]> {
        validateDimension(query, this.dimension);
        distanceType = distanceType || this.defaultDistance;
        if (!this.index) {
            await this.buildIndex();
        }
        const candidateIds = this.index ? this.index.query(query, radius) : [];
        const entries: VectorEntry[] = [];
        for (const id of candidateIds) {
            const e = await this.get(id);
            if (e) entries.push(e);
        }
        // fallback to full search if no candidates
        if (entries.length === 0) {
            const all = await this.getAllEntries();
            for (const e of all) entries.push(e);
        }

        const results: SearchResult[] = [];
        const queryNorm = distanceType === 'cosine' ? this.calculateNorm(query) : 0;
        for (const entry of entries) {
            let score: number;
            if (distanceType === 'cosine') {
                const dot = vectorDotProduct(query, entry.vector);
                score = queryNorm === 0 || !entry.norm ? 0 : dot / (queryNorm * (entry.norm || 0));
            } else if (distanceType === 'l2') {
                score = -euclideanDistance(query, entry.vector);
            } else if (distanceType === 'l1') {
                score = -manhattanDistance(query, entry.vector);
            } else if (distanceType === 'dot') {
                score = vectorDotProduct(query, entry.vector);
            } else if (distanceType === 'hamming') {
                score = -hammingDistance(query, entry.vector);
            } else {
                score = -minkowskiDistance(query, entry.vector, this.minkowskiP);
            }
            results.push({ id: entry.id, score, metadata: entry.metadata });
        }
        return results.sort((a, b) => b.score - a.score).slice(0, k);
    }

    private calculateNorm(vector: Float32Array): number {
        return Math.sqrt(Array.from(vector).reduce((sum, val) => sum + val ** 2, 0));
    }

}
