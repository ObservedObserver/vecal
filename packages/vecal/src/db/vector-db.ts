import { VectorDBConfig, VectorEntry, SearchResult, DistanceType } from './types';
import { cosineSimilarity, euclideanDistance } from '../lib/similarity';
import { generateId } from '../utils/id';
import { validateDimension } from '../utils/validation';

export class VectorDB {
    private dbName: string;
    private dimension: number;
    private storeName: string;
    private dbPromise: Promise<IDBDatabase>;

    constructor(config: VectorDBConfig) {
        this.dbName = config.dbName;
        this.dimension = config.dimension;
        this.storeName = config.storeName || 'vectors';
        this.dbPromise = this.initDB();
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

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
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
            tx.oncomplete = () => resolve(id);
            tx.onerror = () => reject(tx.error);
        });
    }

    async get(id: string): Promise<VectorEntry | undefined> {
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.get(id);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async update(id: string, update: Partial<Omit<VectorEntry, 'id'>>): Promise<void> {
        const db = await this.dbPromise;
        return new Promise(async (resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);

            const current = await store.get(id);
            if (!current) return reject(new Error('Entry not found'));

            const updatedEntry = {
                ...current,
                ...update,
                id, // Ensure ID cannot be modified
            };

            if (updatedEntry.vector) {
                validateDimension(updatedEntry.vector, this.dimension);
                updatedEntry.norm = this.calculateNorm(updatedEntry.vector);
            }

            store.put(updatedEntry);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async delete(id: string): Promise<void> {
        const db = await this.dbPromise;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            store.delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async search(query: Float32Array, k: number = 5, distanceType: DistanceType = 'cosine'): Promise<SearchResult[]> {
        validateDimension(query, this.dimension);
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
                const dotProduct = this.dotProduct(query, entry.vector);
                score = dotProduct / (queryNorm * (entry.norm || 0));
            } else {
                score = -euclideanDistance(query, entry.vector); // 负号转为相似度（越大越好）
            }

            results.push({
                id: entry.id,
                score,
                metadata: entry.metadata,
            });
        }

        return results.sort((a, b) => b.score - a.score).slice(0, k);
    }

    private calculateNorm(vector: Float32Array): number {
        return Math.sqrt(Array.from(vector).reduce((sum, val) => sum + val ** 2, 0));
    }

    private dotProduct(a: Float32Array, b: Float32Array): number {
        let sum = 0;
        for (let i = 0; i < a.length; i++) {
            sum += a[i] * b[i];
        }
        return sum;
    }
}
