import { compareIds } from './math.js';

export interface ScoredValue<T> {
    value: T;
    score: number;
    tieBreaker: string;
}

function isBetter<T>(left: ScoredValue<T>, right: ScoredValue<T>): boolean {
    return left.score > right.score || (left.score === right.score && left.tieBreaker < right.tieBreaker);
}

function isWorse<T>(left: ScoredValue<T>, right: ScoredValue<T>): boolean {
    return isBetter(right, left);
}

export class TopK<T> {
    private readonly heap: ScoredValue<T>[] = [];

    constructor(private readonly capacity: number) {}

    push(item: ScoredValue<T>): void {
        if (this.heap.length < this.capacity) {
            this.heap.push(item);
            this.bubbleUp(this.heap.length - 1);
            return;
        }
        if (!isBetter(item, this.heap[0])) return;
        this.heap[0] = item;
        this.bubbleDown(0);
    }

    values(): T[] {
        return [...this.heap]
            .sort((left, right) => right.score - left.score || compareIds(left.tieBreaker, right.tieBreaker))
            .map((item) => item.value);
    }

    private bubbleUp(start: number): void {
        let index = start;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (!isWorse(this.heap[index], this.heap[parent])) break;
            [this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]];
            index = parent;
        }
    }

    private bubbleDown(start: number): void {
        let index = start;
        while (true) {
            let worst = index;
            const left = index * 2 + 1;
            const right = left + 1;
            if (left < this.heap.length && isWorse(this.heap[left], this.heap[worst])) worst = left;
            if (right < this.heap.length && isWorse(this.heap[right], this.heap[worst])) worst = right;
            if (worst === index) return;
            [this.heap[index], this.heap[worst]] = [this.heap[worst], this.heap[index]];
            index = worst;
        }
    }
}
