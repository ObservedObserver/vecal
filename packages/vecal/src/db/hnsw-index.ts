import { euclideanDistance } from '../lib/similarity';

export interface HNSWLayer {
    entryPoint: number;
    neighbors: Uint32Array[];
    vectors: Float32Array[];
}

export interface HNSWSearchResult {
    id: string;
    distance: number;
}

export interface HNSWSerializedIndex {
    dim: number;
    m: number;
    efConstruction: number;
    maxM: number;
    maxM0: number;
    levelMultiplier: number;
    ids: string[];
    vectors: number[][];
    levels: number[];
    neighbors: number[][][];
    entryPoint: number;
    maxLevel: number;
}

interface ScoredNode {
    index: number;
    distance: number;
}

export class HNSWIndex {
    private dim: number;
    private m: number;
    private efConstruction: number;
    private maxM: number;
    private maxM0: number;
    private levelMultiplier: number;

    private ids: string[] = [];
    private vectors: Float32Array[] = [];
    private levels: number[] = [];
    private neighbors: number[][][] = [];
    private entryPoint = -1;
    private maxLevel = -1;

    constructor(dim: number, m = 16, efConstruction = 200) {
        this.dim = dim;
        this.m = Math.max(2, m);
        this.efConstruction = Math.max(2, efConstruction);
        this.maxM = this.m;
        this.maxM0 = this.m * 2;
        this.levelMultiplier = 1 / Math.log(this.m);
    }

    private normalizeVector(vector: Float32Array): Float32Array {
        if (vector instanceof Float32Array) {
            return vector;
        }

        const maybeLength = (vector as any)?.length;
        if (typeof maybeLength === 'number') {
            return Float32Array.from(Array.from(vector as unknown as ArrayLike<number>));
        }

        return Float32Array.from(Object.values(vector as unknown as Record<string, number>));
    }

    private validateVector(vector: Float32Array): Float32Array {
        const normalized = this.normalizeVector(vector);
        if (normalized.length !== this.dim) {
            throw new Error(`Vector dimension mismatch. Expected ${this.dim}, got ${normalized.length}`);
        }
        return normalized;
    }

    private randomLevel(): number {
        const u = Math.max(Math.random(), Number.MIN_VALUE);
        return Math.floor(-Math.log(u) * this.levelMultiplier);
    }

    private maxConnections(level: number): number {
        return level === 0 ? this.maxM0 : this.maxM;
    }

    private distanceToNode(query: Float32Array, nodeIndex: number): number {
        return euclideanDistance(query, this.vectors[nodeIndex]);
    }

    private insertSorted(list: ScoredNode[], item: ScoredNode, maxSize?: number): void {
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (list[mid].distance <= item.distance) lo = mid + 1;
            else hi = mid;
        }
        list.splice(lo, 0, item);
        if (maxSize !== undefined && list.length > maxSize) {
            list.pop();
        }
    }

    private removeNode(list: number[], nodeIndex: number): void {
        const idx = list.indexOf(nodeIndex);
        if (idx !== -1) {
            list.splice(idx, 1);
        }
    }

    private hasLevel(nodeIndex: number, level: number): boolean {
        return level <= this.levels[nodeIndex];
    }

    private getNeighborList(nodeIndex: number, level: number): number[] {
        if (!this.hasLevel(nodeIndex, level)) return [];
        return this.neighbors[nodeIndex][level];
    }

    private pruneNeighbors(nodeIndex: number, level: number, maxNeighbors: number): void {
        const list = this.getNeighborList(nodeIndex, level);
        if (list.length <= maxNeighbors) return;

        const scored = list
            .map((neighbor) => ({
                index: neighbor,
                distance: euclideanDistance(this.vectors[nodeIndex], this.vectors[neighbor]),
            }))
            .sort((a, b) => a.distance - b.distance);

        const kept = scored.slice(0, maxNeighbors).map((s) => s.index);
        const removed = list.filter((idx) => !kept.includes(idx));
        this.neighbors[nodeIndex][level] = kept;

        for (const removedNode of removed) {
            const reverse = this.getNeighborList(removedNode, level);
            this.removeNode(reverse, nodeIndex);
        }
    }

    private addDirectedEdge(from: number, to: number, level: number): void {
        const list = this.getNeighborList(from, level);
        if (!list.includes(to)) {
            list.push(to);
        }
        this.pruneNeighbors(from, level, this.maxConnections(level));
    }

    private connectBidirectional(a: number, b: number, level: number): void {
        this.addDirectedEdge(a, b, level);
        this.addDirectedEdge(b, a, level);
    }

    private greedySearchLayer(query: Float32Array, entryPoint: number, level: number): number {
        let current = entryPoint;
        let currentDistance = this.distanceToNode(query, current);
        let improved = true;

        while (improved) {
            improved = false;
            for (const neighbor of this.getNeighborList(current, level)) {
                const d = this.distanceToNode(query, neighbor);
                if (d < currentDistance) {
                    current = neighbor;
                    currentDistance = d;
                    improved = true;
                }
            }
        }

        return current;
    }

    private searchLayer(query: Float32Array, entryPoints: number[], ef: number, level: number): ScoredNode[] {
        const visited = new Set<number>();
        const candidates: ScoredNode[] = [];
        const topCandidates: ScoredNode[] = [];

        for (const entryPoint of entryPoints) {
            if (entryPoint < 0 || entryPoint >= this.vectors.length || !this.hasLevel(entryPoint, level) || visited.has(entryPoint)) {
                continue;
            }
            visited.add(entryPoint);
            const distance = this.distanceToNode(query, entryPoint);
            this.insertSorted(candidates, { index: entryPoint, distance });
            this.insertSorted(topCandidates, { index: entryPoint, distance }, ef);
        }

        while (candidates.length > 0) {
            const current = candidates.shift()!;
            const worstTop = topCandidates[topCandidates.length - 1];
            if (worstTop && topCandidates.length >= ef && current.distance > worstTop.distance) {
                break;
            }

            for (const neighbor of this.getNeighborList(current.index, level)) {
                if (visited.has(neighbor)) continue;
                visited.add(neighbor);
                const distance = this.distanceToNode(query, neighbor);
                const threshold = topCandidates[topCandidates.length - 1]?.distance ?? Infinity;
                if (topCandidates.length < ef || distance < threshold) {
                    this.insertSorted(candidates, { index: neighbor, distance });
                    this.insertSorted(topCandidates, { index: neighbor, distance }, ef);
                }
            }
        }

        return topCandidates;
    }

    private selectNeighborsHeuristic(query: Float32Array, candidates: ScoredNode[], maxNeighbors: number): ScoredNode[] {
        const selected: ScoredNode[] = [];
        const ordered = [...candidates].sort((a, b) => a.distance - b.distance);

        for (const candidate of ordered) {
            let keep = true;
            for (const chosen of selected) {
                const interNodeDistance = euclideanDistance(this.vectors[candidate.index], this.vectors[chosen.index]);
                if (interNodeDistance < candidate.distance) {
                    keep = false;
                    break;
                }
            }
            if (keep) {
                selected.push(candidate);
                if (selected.length >= maxNeighbors) break;
            }
        }

        if (selected.length < maxNeighbors) {
            for (const candidate of ordered) {
                if (selected.some((s) => s.index === candidate.index)) continue;
                selected.push(candidate);
                if (selected.length >= maxNeighbors) break;
            }
        }

        return selected;
    }

    build(entries: { id: string; vector: Float32Array }[]): void {
        this.ids = [];
        this.vectors = [];
        this.levels = [];
        this.neighbors = [];
        this.entryPoint = -1;
        this.maxLevel = -1;

        for (const e of entries) {
            this.add(e.id, e.vector);
        }
    }

    add(id: string, vector: Float32Array): void {
        const normalized = this.validateVector(vector);
        const nodeIndex = this.vectors.length;
        const nodeLevel = this.randomLevel();

        this.ids.push(id);
        this.vectors.push(normalized);
        this.levels.push(nodeLevel);
        this.neighbors.push(Array.from({ length: nodeLevel + 1 }, () => []));

        if (this.entryPoint === -1) {
            this.entryPoint = nodeIndex;
            this.maxLevel = nodeLevel;
            return;
        }

        let entryPoint = this.entryPoint;

        for (let level = this.maxLevel; level > nodeLevel; level--) {
            entryPoint = this.greedySearchLayer(normalized, entryPoint, level);
        }

        const topLevel = Math.min(nodeLevel, this.maxLevel);
        for (let level = topLevel; level >= 0; level--) {
            const candidates = this.searchLayer(normalized, [entryPoint], this.efConstruction, level);
            const selected = this.selectNeighborsHeuristic(normalized, candidates, this.maxConnections(level));

            for (const candidate of selected) {
                this.connectBidirectional(nodeIndex, candidate.index, level);
            }

            if (candidates.length > 0) {
                entryPoint = candidates[0].index;
            } else {
                entryPoint = this.greedySearchLayer(normalized, entryPoint, level);
            }
        }

        if (nodeLevel > this.maxLevel) {
            this.entryPoint = nodeIndex;
            this.maxLevel = nodeLevel;
        }
    }

    search(query: Float32Array, k = 1, efSearch = 64): HNSWSearchResult[] {
        if (this.vectors.length === 0) return [];

        const normalizedQuery = this.validateVector(query);
        let entryPoint = this.entryPoint;

        for (let level = this.maxLevel; level > 0; level--) {
            entryPoint = this.greedySearchLayer(normalizedQuery, entryPoint, level);
        }

        const ef = Math.max(k, efSearch);
        const candidates = this.searchLayer(normalizedQuery, [entryPoint], ef, 0);
        return candidates
            .slice(0, k)
            .map((candidate) => ({
                id: this.ids[candidate.index],
                distance: candidate.distance,
            }));
    }

    serialize(): HNSWSerializedIndex {
        return {
            dim: this.dim,
            m: this.m,
            efConstruction: this.efConstruction,
            maxM: this.maxM,
            maxM0: this.maxM0,
            levelMultiplier: this.levelMultiplier,
            ids: [...this.ids],
            vectors: this.vectors.map((v) => Array.from(v)),
            levels: [...this.levels],
            neighbors: this.neighbors.map((levels) => levels.map((list) => [...list])),
            entryPoint: this.entryPoint,
            maxLevel: this.maxLevel,
        };
    }

    static deserialize(data: HNSWSerializedIndex): HNSWIndex {
        const index = new HNSWIndex(data.dim, data.m, data.efConstruction);
        index.maxM = data.maxM;
        index.maxM0 = data.maxM0;
        index.levelMultiplier = data.levelMultiplier;
        index.ids = [...data.ids];
        index.vectors = data.vectors.map((v) => new Float32Array(v));
        index.levels = [...data.levels];
        index.neighbors = data.neighbors.map((levels) => levels.map((list) => [...list]));
        index.entryPoint = data.entryPoint;
        index.maxLevel = data.maxLevel;
        return index;
    }
}
