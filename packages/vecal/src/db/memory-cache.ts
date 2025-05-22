export class LRUCache<K, V> {
    private maxSize: number;
    private map: Map<K, V>;

    constructor(maxSize: number) {
        this.maxSize = maxSize;
        this.map = new Map();
    }

    setMaxSize(size: number) {
        this.maxSize = size;
        this.evictIfNeeded();
    }

    get(key: K): V | undefined {
        const value = this.map.get(key);
        if (value !== undefined) {
            this.map.delete(key);
            this.map.set(key, value);
        }
        return value;
    }

    set(key: K, value: V): void {
        if (this.map.has(key)) {
            this.map.delete(key);
        }
        this.map.set(key, value);
        this.evictIfNeeded();
    }

    delete(key: K): void {
        this.map.delete(key);
    }

    private evictIfNeeded(): void {
        while (this.map.size > this.maxSize) {
            const firstKey = this.map.keys().next().value;
            this.map.delete(firstKey);
        }
    }
}
