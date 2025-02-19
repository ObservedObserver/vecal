export const validateDimension = (vector: Float32Array, expected: number): void => {
    if (vector.length !== expected) {
        throw new Error(`Vector dimension mismatch. Expected ${expected}, got ${vector.length}`);
    }
};
