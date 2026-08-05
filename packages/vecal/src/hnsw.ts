import { OperationCancelledError, ValidationError } from './errors.js';
import { compareIds } from './math.js';
import type { HNSWConfig, IndexBuildProgress, Metric } from './types.js';

const EMPTY_NEIGHBOR = 0xffffffff;
const SNAPSHOT_VERSION = 1;

interface ScoredNode {
    node: number;
    distance: number;
}

class BinaryHeap<T> {
    private values: T[] = [];

    constructor(private readonly precedes: (left: T, right: T) => boolean) {}

    get size(): number {
        return this.values.length;
    }

    peek(): T | undefined {
        return this.values[0];
    }

    push(value: T): void {
        this.values.push(value);
        let index = this.values.length - 1;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (!this.precedes(this.values[index], this.values[parent])) break;
            [this.values[index], this.values[parent]] = [this.values[parent], this.values[index]];
            index = parent;
        }
    }

    pop(): T | undefined {
        if (this.values.length === 0) return undefined;
        const first = this.values[0];
        const last = this.values.pop()!;
        if (this.values.length > 0) {
            this.values[0] = last;
            let index = 0;
            while (true) {
                const left = index * 2 + 1;
                const right = left + 1;
                let next = index;
                if (left < this.values.length && this.precedes(this.values[left], this.values[next])) next = left;
                if (right < this.values.length && this.precedes(this.values[right], this.values[next])) next = right;
                if (next === index) break;
                [this.values[index], this.values[next]] = [this.values[next], this.values[index]];
                index = next;
            }
        }
        return first;
    }

    toArray(): T[] {
        return [...this.values];
    }
}

export interface HNSWSearchResult {
    id: string;
    score: number;
}

export interface HNSWSnapshot {
    formatVersion: number;
    dimension: number;
    metric: Metric;
    config: HNSWConfig;
    rngState: number;
    size: number;
    entryPoint: number;
    maxLevel: number;
    ids: string[];
    vectors: Float32Array;
    levels: Uint16Array;
    deleted: Uint8Array;
    nodeLevelOffsets: Uint32Array;
    neighborOffsets: Uint32Array;
    neighbors: Uint32Array;
}

export interface HNSWBuildOptions {
    isCancelled?: () => boolean;
    onProgress?: (progress: IndexBuildProgress) => void;
}

export class HNSWIndex {
    readonly dimension: number;
    readonly metric: Metric;
    readonly config: HNSWConfig;

    private capacity = 0;
    private sizeValue = 0;
    private vectorData = new Float32Array(0);
    private deleted = new Uint8Array(0);
    private visited = new Uint32Array(0);
    private visitEpoch = 0;
    private ids: string[] = [];
    private levels = new Uint16Array(0);
    private nodeNeighborOffsets = new Uint32Array(0);
    private nodeLevelOffsets = new Uint32Array(0);
    private neighbors = new Uint32Array(0);
    private neighborDistances = new Float32Array(0);
    private neighborCounts = new Uint16Array(0);
    private neighborCapacity = 0;
    private neighborSize = 0;
    private levelListCapacity = 0;
    private levelListSize = 0;
    private idToNode = new Map<string, number>();
    private entryPoint = -1;
    private maxLevel = -1;
    private rngState: number;
    private deletedCount = 0;

    constructor(dimension: number, metric: Metric, config: HNSWConfig) {
        if (!Number.isSafeInteger(dimension) || dimension <= 0) throw new ValidationError('HNSW dimension must be positive');
        if (!Number.isSafeInteger(config.m) || config.m < 2) throw new ValidationError('HNSW m must be an integer >= 2');
        if (!Number.isSafeInteger(config.efConstruction) || config.efConstruction < 2) {
            throw new ValidationError('HNSW efConstruction must be an integer >= 2');
        }
        this.dimension = dimension;
        this.metric = metric;
        this.config = { ...config, seed: config.seed >>> 0 };
        this.rngState = this.config.seed || 1;
    }

    get size(): number {
        return this.sizeValue;
    }

    get liveCount(): number {
        return this.sizeValue - this.deletedCount;
    }

    get tombstoneRatio(): number {
        return this.sizeValue === 0 ? 0 : this.deletedCount / this.sizeValue;
    }

    async build(entries: { id: string; vector: Float32Array }[], options: HNSWBuildOptions = {}): Promise<void> {
        this.reset();
        const total = entries.length;
        options.onProgress?.({ completed: 0, total, ratio: total === 0 ? 1 : 0 });
        for (let index = 0; index < total; index++) {
            if (options.isCancelled?.()) throw new OperationCancelledError();
            this.add(entries[index].id, entries[index].vector);
            if ((index + 1) % 128 === 0 || index + 1 === total) {
                options.onProgress?.({ completed: index + 1, total, ratio: total === 0 ? 1 : (index + 1) / total });
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                if (options.isCancelled?.()) throw new OperationCancelledError();
            }
        }
    }

    add(id: string, vector: Float32Array): void {
        this.validateVector(vector);
        const previous = this.idToNode.get(id);
        if (previous !== undefined && this.deleted[previous] === 0) this.markNodeDeleted(previous);

        const node = this.sizeValue;
        const level = this.randomLevel();
        this.ensureCapacity(node + 1);
        this.vectorData.set(vector, node * this.dimension);
        this.deleted[node] = 0;
        this.ids[node] = id;
        this.levels[node] = level;
        this.allocateNodeGraphStorage(node, level);
        this.idToNode.set(id, node);
        this.sizeValue++;

        if (this.entryPoint === -1) {
            this.entryPoint = node;
            this.maxLevel = level;
            return;
        }

        let entryPoint = this.entryPoint;
        for (let currentLevel = this.maxLevel; currentLevel > level; currentLevel--) {
            entryPoint = this.greedySearchLayer(vector, entryPoint, currentLevel);
        }

        for (let currentLevel = Math.min(level, this.maxLevel); currentLevel >= 0; currentLevel--) {
            const candidates = this.searchLayer(vector, [entryPoint], this.config.efConstruction, currentLevel);
            const selected = this.selectNeighborsHeuristic(candidates, this.maxConnections(currentLevel));
            for (const candidate of selected) this.connectBidirectional(node, candidate.node, currentLevel);
            if (candidates.length > 0) entryPoint = candidates[0].node;
        }

        if (level > this.maxLevel) {
            this.entryPoint = node;
            this.maxLevel = level;
        }
    }

    markDeleted(id: string): boolean {
        const node = this.idToNode.get(id);
        if (node === undefined || this.deleted[node] === 1) return false;
        this.markNodeDeleted(node);
        return true;
    }

    search(query: Float32Array, k: number, efSearch: number, isCancelled?: () => boolean): HNSWSearchResult[] {
        this.validateVector(query);
        if (isCancelled?.()) throw new OperationCancelledError();
        if (this.liveCount === 0 || this.entryPoint < 0) return [];

        let entryPoint = this.entryPoint;
        for (let level = this.maxLevel; level > 0; level--) {
            entryPoint = this.greedySearchLayer(query, entryPoint, level, isCancelled);
        }

        let ef = Math.min(this.sizeValue, Math.max(k, efSearch));
        let active: ScoredNode[] = [];
        while (true) {
            active = this.searchLayer(query, [entryPoint], ef, 0, isCancelled).filter(
                (candidate) => this.deleted[candidate.node] === 0
            );
            if (active.length >= k || ef >= this.sizeValue) break;
            ef = Math.min(this.sizeValue, Math.max(ef + 1, ef * 2));
        }

        return active
            .map((candidate) => ({
                id: this.ids[candidate.node],
                score: this.scoreToNode(query, candidate.node),
            }))
            .sort((left, right) => right.score - left.score || compareIds(left.id, right.id))
            .slice(0, k);
    }

    async searchAsync(
        query: Float32Array,
        k: number,
        efSearch: number,
        isCancelled: () => boolean
    ): Promise<HNSWSearchResult[]> {
        this.validateVector(query);
        if (isCancelled()) throw new OperationCancelledError();
        if (this.liveCount === 0 || this.entryPoint < 0) return [];

        let entryPoint = this.entryPoint;
        for (let level = this.maxLevel; level > 0; level--) {
            entryPoint = this.greedySearchLayer(query, entryPoint, level, isCancelled);
        }

        let ef = Math.min(this.sizeValue, Math.max(k, efSearch));
        let active: ScoredNode[] = [];
        while (true) {
            active = (await this.searchLayerAsync(query, entryPoint, ef, isCancelled)).filter(
                (candidate) => this.deleted[candidate.node] === 0
            );
            if (active.length >= k || ef >= this.sizeValue) break;
            ef = Math.min(this.sizeValue, Math.max(ef + 1, ef * 2));
        }

        return active
            .map((candidate) => ({ id: this.ids[candidate.node], score: this.scoreToNode(query, candidate.node) }))
            .sort((left, right) => right.score - left.score || compareIds(left.id, right.id))
            .slice(0, k);
    }

    serialize(): HNSWSnapshot {
        const nodeLevelOffsets = new Uint32Array(this.sizeValue + 1);
        let listCount = 0;
        for (let node = 0; node < this.sizeValue; node++) {
            nodeLevelOffsets[node] = listCount;
            listCount += this.levels[node] + 1;
        }
        nodeLevelOffsets[this.sizeValue] = listCount;

        const neighborOffsets = new Uint32Array(listCount + 1);
        let neighborCount = 0;
        let listIndex = 0;
        for (let node = 0; node < this.sizeValue; node++) {
            for (let level = 0; level <= this.levels[node]; level++) {
                neighborOffsets[listIndex++] = neighborCount;
                neighborCount += this.neighborCount(node, level);
            }
        }
        neighborOffsets[listCount] = neighborCount;

        const flattenedNeighbors = new Uint32Array(neighborCount);
        let offset = 0;
        for (let node = 0; node < this.sizeValue; node++) {
            for (let level = 0; level <= this.levels[node]; level++) {
                const count = this.neighborCount(node, level);
                flattenedNeighbors.set(this.neighborValues(node, level), offset);
                offset += count;
            }
        }

        return {
            formatVersion: SNAPSHOT_VERSION,
            dimension: this.dimension,
            metric: this.metric,
            config: { ...this.config },
            rngState: this.rngState,
            size: this.sizeValue,
            entryPoint: this.entryPoint,
            maxLevel: this.maxLevel,
            ids: this.ids.slice(0, this.sizeValue),
            vectors: this.vectorData.slice(0, this.sizeValue * this.dimension),
            levels: this.levels.slice(0, this.sizeValue),
            deleted: this.deleted.slice(0, this.sizeValue),
            nodeLevelOffsets,
            neighborOffsets,
            neighbors: flattenedNeighbors,
        };
    }

    static deserialize(snapshot: HNSWSnapshot): HNSWIndex {
        if (snapshot.formatVersion !== SNAPSHOT_VERSION) throw new ValidationError('Unsupported HNSW snapshot version');
        const index = new HNSWIndex(snapshot.dimension, snapshot.metric, snapshot.config);
        index.ensureCapacity(snapshot.size);
        index.sizeValue = snapshot.size;
        index.entryPoint = snapshot.entryPoint;
        index.maxLevel = snapshot.maxLevel;
        index.rngState = snapshot.rngState;
        index.ids = [...snapshot.ids];
        index.vectorData.set(snapshot.vectors);
        index.deleted.set(snapshot.deleted);
        index.deletedCount = 0;

        for (let node = 0; node < snapshot.size; node++) {
            const nodeLevel = snapshot.levels[node];
            index.levels[node] = nodeLevel;
            index.allocateNodeGraphStorage(node, nodeLevel);
            const levelCount = nodeLevel + 1;
            for (let level = 0; level < levelCount; level++) {
                const listIndex = snapshot.nodeLevelOffsets[node] + level;
                const start = snapshot.neighborOffsets[listIndex];
                const end = snapshot.neighborOffsets[listIndex + 1];
                const listOffset = index.neighborOffset(node, level);
                index.neighbors.set(snapshot.neighbors.subarray(start, end), listOffset);
                for (let neighbor = 0; neighbor < end - start; neighbor++) {
                    index.neighborDistances[listOffset + neighbor] = index.distanceBetweenNodes(
                        node,
                        index.neighbors[listOffset + neighbor]
                    );
                }
                index.setNeighborCount(node, level, end - start);
            }
            if (index.deleted[node] === 1) index.deletedCount++;
            else index.idToNode.set(index.ids[node], node);
        }
        return index;
    }

    private reset(): void {
        this.capacity = 0;
        this.sizeValue = 0;
        this.vectorData = new Float32Array(0);
        this.deleted = new Uint8Array(0);
        this.visited = new Uint32Array(0);
        this.visitEpoch = 0;
        this.ids = [];
        this.levels = new Uint16Array(0);
        this.nodeNeighborOffsets = new Uint32Array(0);
        this.nodeLevelOffsets = new Uint32Array(0);
        this.neighbors = new Uint32Array(0);
        this.neighborCounts = new Uint16Array(0);
        this.neighborDistances = new Float32Array(0);
        this.neighborCapacity = 0;
        this.neighborSize = 0;
        this.levelListCapacity = 0;
        this.levelListSize = 0;
        this.idToNode.clear();
        this.entryPoint = -1;
        this.maxLevel = -1;
        this.rngState = this.config.seed || 1;
        this.deletedCount = 0;
    }

    private validateVector(vector: Float32Array): void {
        if (!(vector instanceof Float32Array) || vector.length !== this.dimension) {
            throw new ValidationError(`HNSW vector dimension mismatch. Expected ${this.dimension}`);
        }
    }

    private ensureCapacity(required: number): void {
        if (required <= this.capacity) return;
        const next = Math.max(required, this.capacity === 0 ? 16 : this.capacity * 2);
        const vectors = new Float32Array(next * this.dimension);
        vectors.set(this.vectorData);
        this.vectorData = vectors;
        const deleted = new Uint8Array(next);
        deleted.set(this.deleted);
        this.deleted = deleted;
        const visited = new Uint32Array(next);
        visited.set(this.visited);
        this.visited = visited;
        const levels = new Uint16Array(next);
        levels.set(this.levels);
        this.levels = levels;
        const nodeNeighborOffsets = new Uint32Array(next + 1);
        nodeNeighborOffsets.set(this.nodeNeighborOffsets);
        this.nodeNeighborOffsets = nodeNeighborOffsets;
        const nodeLevelOffsets = new Uint32Array(next + 1);
        nodeLevelOffsets.set(this.nodeLevelOffsets);
        this.nodeLevelOffsets = nodeLevelOffsets;
        this.capacity = next;
    }

    private allocateNodeGraphStorage(node: number, level: number): void {
        const neighborSlots = this.maxConnections(0) + level * this.config.m;
        const levelLists = level + 1;
        this.ensureNeighborCapacity(this.neighborSize + neighborSlots);
        this.ensureLevelListCapacity(this.levelListSize + levelLists);
        this.nodeNeighborOffsets[node] = this.neighborSize;
        this.nodeLevelOffsets[node] = this.levelListSize;
        this.neighbors.fill(EMPTY_NEIGHBOR, this.neighborSize, this.neighborSize + neighborSlots);
        this.neighborDistances.fill(0, this.neighborSize, this.neighborSize + neighborSlots);
        this.neighborCounts.fill(0, this.levelListSize, this.levelListSize + levelLists);
        this.neighborSize += neighborSlots;
        this.levelListSize += levelLists;
        this.nodeNeighborOffsets[node + 1] = this.neighborSize;
        this.nodeLevelOffsets[node + 1] = this.levelListSize;
    }

    private ensureNeighborCapacity(required: number): void {
        if (required <= this.neighborCapacity) return;
        const next = Math.max(required, this.neighborCapacity === 0 ? 256 : this.neighborCapacity * 2);
        const neighbors = new Uint32Array(next);
        neighbors.fill(EMPTY_NEIGHBOR);
        neighbors.set(this.neighbors);
        this.neighbors = neighbors;
        const distances = new Float32Array(next);
        distances.set(this.neighborDistances);
        this.neighborDistances = distances;
        this.neighborCapacity = next;
    }

    private ensureLevelListCapacity(required: number): void {
        if (required <= this.levelListCapacity) return;
        const next = Math.max(required, this.levelListCapacity === 0 ? 32 : this.levelListCapacity * 2);
        const counts = new Uint16Array(next);
        counts.set(this.neighborCounts);
        this.neighborCounts = counts;
        this.levelListCapacity = next;
    }

    private nextRandom(): number {
        this.rngState = (Math.imul(1664525, this.rngState) + 1013904223) >>> 0;
        return (this.rngState + 1) / 4294967297;
    }

    private randomLevel(): number {
        const multiplier = 1 / Math.log(this.config.m);
        return Math.min(32, Math.floor(-Math.log(this.nextRandom()) * multiplier));
    }

    private maxConnections(level: number): number {
        return level === 0 ? this.config.m * 2 : this.config.m;
    }

    private neighborOffset(node: number, level: number): number {
        return this.nodeNeighborOffsets[node] + (level === 0 ? 0 : this.maxConnections(0) + (level - 1) * this.config.m);
    }

    private neighborCount(node: number, level: number): number {
        return this.neighborCounts[this.nodeLevelOffsets[node] + level];
    }

    private setNeighborCount(node: number, level: number, count: number): void {
        this.neighborCounts[this.nodeLevelOffsets[node] + level] = count;
    }

    private distanceToNode(query: Float32Array, node: number): number {
        const offset = node * this.dimension;
        if (this.metric === 'l2') {
            let squaredDistance = 0;
            for (let component = 0; component < this.dimension; component++) {
                const difference = query[component] - this.vectorData[offset + component];
                squaredDistance += difference * difference;
            }
            // HNSW only compares distances, so avoiding sqrt preserves ordering.
            return squaredDistance;
        }
        let dot = 0;
        for (let component = 0; component < this.dimension; component++) {
            dot += query[component] * this.vectorData[offset + component];
        }
        return -dot;
    }

    private distanceBetweenNodes(left: number, right: number): number {
        const leftOffset = left * this.dimension;
        const rightOffset = right * this.dimension;
        if (this.metric === 'l2') {
            let squaredDistance = 0;
            for (let component = 0; component < this.dimension; component++) {
                const difference = this.vectorData[leftOffset + component] - this.vectorData[rightOffset + component];
                squaredDistance += difference * difference;
            }
            return squaredDistance;
        }
        let dot = 0;
        for (let component = 0; component < this.dimension; component++) {
            dot += this.vectorData[leftOffset + component] * this.vectorData[rightOffset + component];
        }
        return -dot;
    }

    private scoreToNode(query: Float32Array, node: number): number {
        const distance = this.distanceToNode(query, node);
        return this.metric === 'l2' ? -Math.sqrt(distance) : -distance;
    }

    private neighborValues(node: number, level: number): Uint32Array {
        if (level > this.levels[node]) return new Uint32Array(0);
        const offset = this.neighborOffset(node, level);
        return this.neighbors.subarray(offset, offset + this.neighborCount(node, level));
    }

    private greedySearchLayer(
        query: Float32Array,
        entryPoint: number,
        level: number,
        isCancelled?: () => boolean
    ): number {
        let current = entryPoint;
        let currentDistance = this.distanceToNode(query, current);
        let improved = true;
        while (improved) {
            if (isCancelled?.()) throw new OperationCancelledError();
            improved = false;
            const offset = this.neighborOffset(current, level);
            const count = this.neighborCount(current, level);
            for (let index = 0; index < count; index++) {
                const neighbor = this.neighbors[offset + index];
                const distance = this.distanceToNode(query, neighbor);
                if (distance < currentDistance) {
                    current = neighbor;
                    currentDistance = distance;
                    improved = true;
                }
            }
        }
        return current;
    }

    private searchLayer(
        query: Float32Array,
        entryPoints: number[],
        ef: number,
        level: number,
        isCancelled?: () => boolean
    ): ScoredNode[] {
        const visitEpoch = this.nextVisitEpoch();
        const candidates = new BinaryHeap<ScoredNode>((left, right) => left.distance < right.distance);
        const best = new BinaryHeap<ScoredNode>((left, right) => left.distance > right.distance);

        for (const entryPoint of entryPoints) {
            if (
                entryPoint < 0 ||
                entryPoint >= this.sizeValue ||
                level > this.levels[entryPoint] ||
                this.visited[entryPoint] === visitEpoch
            ) {
                continue;
            }
            this.visited[entryPoint] = visitEpoch;
            const item = { node: entryPoint, distance: this.distanceToNode(query, entryPoint) };
            candidates.push(item);
            best.push(item);
        }

        let visitedSinceCancellationCheck = 0;
        while (candidates.size > 0) {
            if (visitedSinceCancellationCheck >= 64) {
                if (isCancelled?.()) throw new OperationCancelledError();
                visitedSinceCancellationCheck = 0;
            }
            const current = candidates.pop()!;
            const worst = best.peek();
            if (worst && best.size >= ef && current.distance > worst.distance) break;
            const offset = this.neighborOffset(current.node, level);
            const count = this.neighborCount(current.node, level);
            for (let index = 0; index < count; index++) {
                const neighbor = this.neighbors[offset + index];
                if (this.visited[neighbor] === visitEpoch) continue;
                this.visited[neighbor] = visitEpoch;
                visitedSinceCancellationCheck++;
                const item = { node: neighbor, distance: this.distanceToNode(query, neighbor) };
                const threshold = best.peek()?.distance ?? Infinity;
                if (best.size < ef || item.distance < threshold) {
                    candidates.push(item);
                    best.push(item);
                    if (best.size > ef) best.pop();
                }
            }
        }

        if (isCancelled?.()) throw new OperationCancelledError();
        return best.toArray().sort((left, right) => left.distance - right.distance || left.node - right.node);
    }

    private async searchLayerAsync(
        query: Float32Array,
        entryPoint: number,
        ef: number,
        isCancelled: () => boolean
    ): Promise<ScoredNode[]> {
        const visitEpoch = this.nextVisitEpoch();
        const candidates = new BinaryHeap<ScoredNode>((left, right) => left.distance < right.distance);
        const best = new BinaryHeap<ScoredNode>((left, right) => left.distance > right.distance);
        this.visited[entryPoint] = visitEpoch;
        const first = { node: entryPoint, distance: this.distanceToNode(query, entryPoint) };
        candidates.push(first);
        best.push(first);

        let visitedSinceYield = 0;
        while (candidates.size > 0) {
            const current = candidates.pop()!;
            const worst = best.peek();
            if (worst && best.size >= ef && current.distance > worst.distance) break;
            const offset = this.neighborOffset(current.node, 0);
            const count = this.neighborCount(current.node, 0);
            for (let index = 0; index < count; index++) {
                const neighbor = this.neighbors[offset + index];
                if (this.visited[neighbor] === visitEpoch) continue;
                this.visited[neighbor] = visitEpoch;
                const item = { node: neighbor, distance: this.distanceToNode(query, neighbor) };
                const threshold = best.peek()?.distance ?? Infinity;
                if (best.size < ef || item.distance < threshold) {
                    candidates.push(item);
                    best.push(item);
                    if (best.size > ef) best.pop();
                }
                visitedSinceYield++;
                if (visitedSinceYield >= 256) {
                    await new Promise<void>((resolve) => setTimeout(resolve, 0));
                    if (isCancelled()) throw new OperationCancelledError();
                    visitedSinceYield = 0;
                }
            }
        }
        if (isCancelled()) throw new OperationCancelledError();
        return best.toArray().sort((left, right) => left.distance - right.distance || left.node - right.node);
    }

    private nextVisitEpoch(): number {
        this.visitEpoch = (this.visitEpoch + 1) >>> 0;
        if (this.visitEpoch === 0) {
            this.visited.fill(0);
            this.visitEpoch = 1;
        }
        return this.visitEpoch;
    }

    private selectNeighborsHeuristic(candidates: ScoredNode[], limit: number): ScoredNode[] {
        const selected: ScoredNode[] = [];
        const discarded: ScoredNode[] = [];
        for (const candidate of candidates) {
            let diverse = true;
            for (const existing of selected) {
                if (this.distanceBetweenNodes(candidate.node, existing.node) < candidate.distance) {
                    diverse = false;
                    break;
                }
            }
            (diverse ? selected : discarded).push(candidate);
            if (selected.length >= limit) return selected;
        }
        // Keeping pruned connections fills sparse layers while the first pass
        // determines which edges survive when the candidate set is overfull.
        for (const candidate of discarded) {
            selected.push(candidate);
            if (selected.length >= limit) break;
        }
        return selected;
    }

    private connectBidirectional(left: number, right: number, level: number): void {
        this.addDirectedEdge(left, right, level);
        this.addDirectedEdge(right, left, level);
    }

    private addDirectedEdge(from: number, to: number, level: number): void {
        const offset = this.neighborOffset(from, level);
        const capacity = this.maxConnections(level);
        let count = this.neighborCount(from, level);
        for (let index = 0; index < count; index++) if (this.neighbors[offset + index] === to) return;
        const newDistance = this.distanceBetweenNodes(from, to);
        if (count < capacity) {
            this.neighbors[offset + count] = to;
            this.neighborDistances[offset + count] = newDistance;
            this.setNeighborCount(from, level, count + 1);
            return;
        }

        // The existing set has already been pruned online. Test the incoming
        // candidate against nearer neighbors, which preserves HNSW diversity
        // without rerunning an O(M² × dimension) heuristic for every back-link.
        for (let index = 0; index < count; index++) {
            if (
                this.neighborDistances[offset + index] < newDistance &&
                this.distanceBetweenNodes(to, this.neighbors[offset + index]) < newDistance
            ) {
                return;
            }
        }
        let worstIndex = 0;
        for (let index = 1; index < count; index++) {
            if (
                this.neighborDistances[offset + index] > this.neighborDistances[offset + worstIndex] ||
                (this.neighborDistances[offset + index] === this.neighborDistances[offset + worstIndex] &&
                    this.neighbors[offset + index] > this.neighbors[offset + worstIndex])
            ) {
                worstIndex = index;
            }
        }
        const removedNode = this.neighbors[offset + worstIndex];
        this.neighbors[offset + worstIndex] = to;
        this.neighborDistances[offset + worstIndex] = newDistance;
        this.removeDirectedEdge(removedNode, from, level);
    }

    private removeDirectedEdge(from: number, to: number, level: number): void {
        if (level > this.levels[from]) return;
        const offset = this.neighborOffset(from, level);
        const count = this.neighborCount(from, level);
        for (let index = 0; index < count; index++) {
            if (this.neighbors[offset + index] !== to) continue;
            this.neighbors[offset + index] = this.neighbors[offset + count - 1];
            this.neighborDistances[offset + index] = this.neighborDistances[offset + count - 1];
            this.neighbors[offset + count - 1] = EMPTY_NEIGHBOR;
            this.neighborDistances[offset + count - 1] = 0;
            this.setNeighborCount(from, level, count - 1);
            return;
        }
    }

    private markNodeDeleted(node: number): void {
        if (this.deleted[node] === 1) return;
        this.deleted[node] = 1;
        this.deletedCount++;
        if (this.idToNode.get(this.ids[node]) === node) this.idToNode.delete(this.ids[node]);
    }
}
