import { UnsupportedEnvironmentError, ValidationError } from './errors.js';
import { normalize } from './math.js';
import type { JSONValue, Metadata, Metric } from './types.js';

export function validateOpenOptions(name: string, dimension: number, metric: Metric): void {
    if (typeof name !== 'string' || !name.trim()) throw new ValidationError('name must be a non-empty string');
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
        throw new ValidationError('dimension must be a positive integer');
    }
    if (!['cosine', 'l2', 'dot'].includes(metric)) throw new ValidationError(`Unsupported metric: ${metric}`);
}

export function validateK(k: number): void {
    if (!Number.isSafeInteger(k) || k <= 0) throw new ValidationError('k must be a positive integer');
}

export function prepareVector(vector: Float32Array, dimension: number, metric: Metric): Float32Array {
    if (Object.prototype.toString.call(vector) !== '[object Float32Array]') {
        throw new ValidationError('vector must be a Float32Array');
    }
    if (vector.length !== dimension) {
        throw new ValidationError(`Vector dimension mismatch. Expected ${dimension}, got ${vector.length}`);
    }
    let squaredNorm = 0;
    for (const value of vector) {
        if (!Number.isFinite(value)) throw new ValidationError('vector values must be finite numbers');
        squaredNorm += value * value;
    }
    if (metric === 'cosine' && squaredNorm === 0) throw new ValidationError('cosine metric does not accept zero vectors');
    const localVector = Float32Array.from(vector);
    return metric === 'cosine' ? normalize(localVector) : localVector;
}

export function validateMetadata(metadata: Metadata | undefined): void {
    if (metadata === undefined) return;
    if (!isPlainObject(metadata)) throw new ValidationError('metadata must be a JSON object');
    const seen = new Set<object>();
    validateJSONValue(metadata, 'metadata', seen);
}

function validateJSONValue(value: JSONValue, path: string, seen: Set<object>): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new ValidationError(`${path} contains a non-finite number`);
        return;
    }
    if (typeof value !== 'object') throw new ValidationError(`${path} contains a non-JSON value`);
    if (seen.has(value)) throw new ValidationError(`${path} contains a circular reference`);
    seen.add(value);
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
            if (!Object.prototype.hasOwnProperty.call(value, index)) {
                throw new ValidationError(`${path}[${index}] is missing`);
            }
            validateJSONValue(value[index], `${path}[${index}]`, seen);
        }
    } else {
        if (!isPlainObject(value)) throw new ValidationError(`${path} contains a non-plain object`);
        if (Object.getOwnPropertySymbols(value).length > 0) {
            throw new ValidationError(`${path} contains a symbol key`);
        }
        for (const [key, item] of Object.entries(value)) {
            if (item === undefined) throw new ValidationError(`${path}.${key} is undefined`);
            validateJSONValue(item as JSONValue, `${path}.${key}`, seen);
        }
    }
    seen.delete(value);
}

function isPlainObject(value: unknown): value is Record<string, JSONValue> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function generateId(): string {
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
        throw new UnsupportedEnvironmentError('Vecal requires crypto.randomUUID()');
    }
    return crypto.randomUUID();
}
