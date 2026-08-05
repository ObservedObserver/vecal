import type { Metric } from './types.js';

export function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
    let value = 0;
    for (let index = 0; index < a.length; index++) value += a[index] * b[index];
    return value;
}

export function squaredL2Distance(a: Float32Array, b: Float32Array): number {
    let value = 0;
    for (let index = 0; index < a.length; index++) {
        const difference = a[index] - b[index];
        value += difference * difference;
    }
    return value;
}

export function metricDistance(metric: Metric, a: Float32Array, b: Float32Array): number {
    if (metric === 'l2') return Math.sqrt(squaredL2Distance(a, b));
    const dot = dotProduct(a, b);
    return metric === 'cosine' ? 1 - dot : -dot;
}

export function metricScore(metric: Metric, a: Float32Array, b: Float32Array): number {
    if (metric === 'l2') return -Math.sqrt(squaredL2Distance(a, b));
    return dotProduct(a, b);
}

export function normalize(vector: Float32Array): Float32Array {
    let squaredNorm = 0;
    for (const value of vector) squaredNorm += value * value;
    const norm = Math.sqrt(squaredNorm);
    if (norm === 0) return vector.slice();
    const result = new Float32Array(vector.length);
    for (let index = 0; index < vector.length; index++) result[index] = vector[index] / norm;
    return result;
}
