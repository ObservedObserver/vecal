export interface HNSWLayer {
    entryPoint: number;
    neighbors: Uint32Array[];
    vectors: Float32Array[];
}

export interface HNSWSearchResult {
    id: string;
    distance: number;
}

import { euclideanDistance } from '../lib/similarity';

export class HNSWIndex {
    private dim: number;
    private m: number;
    private efConstruction: number;
    private ids: string[] = [];
    private vectors: Float32Array[] = [];
    private links: number[][] = [];
    private entryPoint = -1;

    constructor(dim: number, m = 16, efConstruction = 200) {
        this.dim = dim;
        this.m = m;
        this.efConstruction = efConstruction;
    }

    build(entries: { id: string; vector: Float32Array }[]): void {
        for (const e of entries) {
            this.add(e.id, e.vector);
        }
    }

    add(id: string, vector: Float32Array): void {
        const index = this.vectors.length;
        this.ids.push(id);
        this.vectors.push(vector);
        this.links.push([]);
        if (this.entryPoint === -1) {
            this.entryPoint = index;
            return;
        }
        const dists = this.vectors.map((v, i) => ({ i, d: i === index ? Infinity : euclideanDistance(vector, v) }));
        dists.sort((a, b) => a.d - b.d);
        const neighbours = dists.slice(0, Math.min(this.m, dists.length)).map((n) => n.i);
        this.links[index].push(...neighbours);
        for (const n of neighbours) {
            this.links[n].push(index);
        }
    }

    search(query: Float32Array, k = 1): HNSWSearchResult[] {
        const dists = this.vectors.map((v, i) => ({ id: this.ids[i], distance: euclideanDistance(query, v) }));
        dists.sort((a, b) => a.distance - b.distance);
        return dists.slice(0, k);
    }
}
