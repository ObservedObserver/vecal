export const cosineSimilarity = (a: Float32Array, b: Float32Array): number => {
    let dot = 0,
        normA = 0,
        normB = 0;
    for (let i = 0; i < a.length; i++) {
        const ai = a[i];
        const bi = b[i];
        if (Number.isNaN(ai) || Number.isNaN(bi)) return NaN;
        dot += ai * bi;
        normA += ai ** 2;
        normB += bi ** 2;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return dot / denom;
};

export const euclideanDistance = (a: Float32Array, b: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const diff = a[i] - b[i];
        if (Number.isNaN(diff)) return NaN;
        sum += diff ** 2;
    }
    return Math.sqrt(sum);
};

export const manhattanDistance = (a: Float32Array, b: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const diff = Math.abs(a[i] - b[i]);
        if (Number.isNaN(diff)) return NaN;
        sum += diff;
    }
    return sum;
};

export const dotProduct = (a: Float32Array, b: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const prod = a[i] * b[i];
        if (Number.isNaN(prod)) return NaN;
        sum += prod;
    }
    return sum;
};

export const hammingDistance = (a: Float32Array, b: Float32Array): number => {
    let dist = 0;
    for (let i = 0; i < a.length; i++) {
        const ai = a[i];
        const bi = b[i];
        if (Number.isNaN(ai) || Number.isNaN(bi)) return NaN;
        if (ai !== bi) dist++;
    }
    return dist;
};

export const minkowskiDistance = (a: Float32Array, b: Float32Array, p: number): number => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const diff = Math.abs(a[i] - b[i]);
        if (Number.isNaN(diff)) return NaN;
        sum += diff ** p;
    }
    return Math.pow(sum, 1 / p);
};
