export class LSHIndex {
    private dimension: number;
    private numHashes: number;
    private hyperplanes: Float32Array[] = [];
    private buckets: Map<string, Set<string>> = new Map();

    constructor(dimension: number, numHashes: number = 10) {
        this.dimension = dimension;
        this.numHashes = numHashes;
        for (let i = 0; i < numHashes; i++) {
            const plane = new Float32Array(dimension);
            for (let j = 0; j < dimension; j++) {
                plane[j] = Math.random() * 2 - 1;
            }
            this.hyperplanes.push(plane);
        }
    }

    private hash(vector: Float32Array): string {
        let bits = '';
        for (const plane of this.hyperplanes) {
            let dot = 0;
            for (let i = 0; i < vector.length; i++) {
                dot += plane[i] * vector[i];
            }
            bits += dot >= 0 ? '1' : '0';
        }
        return bits;
    }

    add(id: string, vector: Float32Array): void {
        const key = this.hash(vector);
        if (!this.buckets.has(key)) {
            this.buckets.set(key, new Set());
        }
        this.buckets.get(key)!.add(id);
    }

    remove(id: string, vector: Float32Array): void {
        const key = this.hash(vector);
        const set = this.buckets.get(key);
        if (!set) return;
        set.delete(id);
        if (set.size === 0) {
            this.buckets.delete(key);
        }
    }

    query(vector: Float32Array, radius: number = 0): string[] {
        const key = this.hash(vector);
        const results = new Set<string>(this.buckets.get(key) || []);
        if (radius > 0) {
            for (const neighbour of this.neighbourKeys(key, radius)) {
                for (const id of this.buckets.get(neighbour) || []) {
                    results.add(id);
                }
            }
        }
        return Array.from(results);
    }

    private neighbourKeys(key: string, radius: number): string[] {
        const keys: Set<string> = new Set();
        const recurse = (prefix: string, bits: string[], idx: number, r: number) => {
            if (r === 0 || idx === bits.length) {
                keys.add(prefix + bits.slice(idx).join(''));
                return;
            }
            // do not flip current bit
            recurse(prefix + bits[idx], bits, idx + 1, r);
            // flip current bit
            const flipped = bits[idx] === '1' ? '0' : '1';
            recurse(prefix + flipped, bits, idx + 1, r - 1);
        };
        recurse('', key.split(''), 0, radius);
        keys.delete(key); // remove original key if present
        return Array.from(keys);
    }
}
