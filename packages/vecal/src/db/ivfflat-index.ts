import { euclideanDistance } from '../lib/similarity';

export interface IVFFlatIndexData {
    centroids: Float32Array[];
    inverted: Map<number, { vector: Float32Array; id: string }[]>;
    metadata: { dim: number; nlist: number; nprobe: number };
}

export class IVFFlatIndex implements IVFFlatIndexData {
    centroids: Float32Array[] = [];
    inverted: Map<number, { vector: Float32Array; id: string }[]> = new Map();
    metadata: { dim: number; nlist: number; nprobe: number };

    constructor(dim: number, nlist = 256, nprobe = 8) {
        this.metadata = { dim, nlist, nprobe };
    }

    build(entries: { id: string; vector: Float32Array }[]): void {
        const { dim, nlist } = this.metadata;
        if (entries.length === 0) return;
        // initialize centroids with first vectors or random
        this.centroids = [];
        for (let i = 0; i < Math.min(nlist, entries.length); i++) {
            const vec = entries[i].vector;
            this.centroids.push(vec instanceof Float32Array ? vec.slice() : new Float32Array(vec));
        }
        // if fewer entries than nlist, fill remaining with random existing vectors
        while (this.centroids.length < nlist) {
            const rand = entries[Math.floor(Math.random() * entries.length)].vector;
            this.centroids.push(rand instanceof Float32Array ? rand.slice() : new Float32Array(rand));
        }
        // simple k-means like iteration
        const assignments = new Array(entries.length).fill(0);
        for (let iter = 0; iter < 5; iter++) {
            // assign
            for (let i = 0; i < entries.length; i++) {
                const vec = entries[i].vector;
                let best = 0;
                let bestDist = Infinity;
                for (let c = 0; c < nlist; c++) {
                    const dist = euclideanDistance(vec, this.centroids[c]);
                    if (dist < bestDist) {
                        bestDist = dist;
                        best = c;
                    }
                }
                assignments[i] = best;
            }
            // update centroids
            const sums: number[][] = Array.from({ length: nlist }, () => Array(dim).fill(0));
            const counts = new Array(nlist).fill(0);
            for (let i = 0; i < entries.length; i++) {
                const cluster = assignments[i];
                counts[cluster]++;
                const vec = entries[i].vector;
                for (let d = 0; d < dim; d++) {
                    sums[cluster][d] += vec[d];
                }
            }
            for (let c = 0; c < nlist; c++) {
                if (counts[c] === 0) continue;
                const centroid = new Float32Array(dim);
                for (let d = 0; d < dim; d++) {
                    centroid[d] = sums[c][d] / counts[c];
                }
                this.centroids[c] = centroid;
            }
        }
        // build inverted lists
        this.inverted = new Map();
        for (let i = 0; i < nlist; i++) this.inverted.set(i, []);
        for (let i = 0; i < entries.length; i++) {
            const cluster = assignments[i];
            this.inverted.get(cluster)!.push({ id: entries[i].id, vector: entries[i].vector });
        }
    }

    add(id: string, vector: Float32Array): void {
        // assign to closest centroid
        const cluster = this.closestCentroid(vector);
        this.inverted.get(cluster)!.push({ id, vector });
    }

    remove(id: string, vector: Float32Array): void {
        const cluster = this.closestCentroid(vector);
        const list = this.inverted.get(cluster);
        if (!list) return;
        const idx = list.findIndex((v) => v.id === id);
        if (idx !== -1) list.splice(idx, 1);
    }

    search(query: Float32Array, k: number): { id: string; distance: number }[] {
        const { nprobe } = this.metadata;
        const dists: { index: number; dist: number }[] = [];
        for (let i = 0; i < this.centroids.length; i++) {
            dists.push({ index: i, dist: euclideanDistance(query, this.centroids[i]) });
        }
        dists.sort((a, b) => a.dist - b.dist);
        let candidates: { id: string; vector: Float32Array }[] = [];
        for (let i = 0; i < Math.min(nprobe, dists.length); i++) {
            const list = this.inverted.get(dists[i].index);
            if (list) candidates = candidates.concat(list);
        }
        const scored = candidates.map((c) => ({ id: c.id, distance: euclideanDistance(query, c.vector) }));
        scored.sort((a, b) => a.distance - b.distance);
        return scored.slice(0, k);
    }

    private closestCentroid(vec: Float32Array): number {
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < this.centroids.length; i++) {
            const dist = euclideanDistance(vec, this.centroids[i]);
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        }
        return best;
    }
}
