export interface VectorEntry {
    id: string;
    vector: number[];
}

export class VectorStore {
    private dbName: string;
    private storeName: string;
    private db: IDBDatabase | null = null;

    constructor(dbName: string = 'VectorDB', storeName: string = 'Vectors') {
        this.dbName = dbName;
        this.storeName = storeName;
    }

    async init(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
            };
            request.onsuccess = (event: Event) => {
                this.db = request.result;
                resolve();
            };
            request.onerror = (event: Event) => {
                reject(new Error(`IndexedDB request failed: ${request.error?.message}`));
            };
        });
    }

    async addVector(id: string, vector: number[]): Promise<void> {
        if (!this.db) {
            throw new Error('Database not initialized');
        }
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.put({ id, vector });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(new Error(`Failed to add vector: ${request.error?.message}`));
        });
    }

    async getVector(id: string): Promise<number[]> {
        if (!this.db) {
            throw new Error('Database not initialized');
        }
        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([this.storeName]);
            const store = transaction.objectStore(this.storeName);
            const request = store.get(id);
            request.onsuccess = () => {
                if (request.result) {
                    resolve(request.result.vector);
                } else {
                    reject(new Error('Vector not found'));
                }
            };
            request.onerror = () => reject(new Error(`Failed to get vector: ${request.error?.message}`));
        });
    }
}
