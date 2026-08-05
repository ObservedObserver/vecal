import { ValidationError } from './errors.js';
import type { ComparisonValue, Metadata, Where, WhereOperator } from './types.js';

const OPERATOR_KEYS = new Set(['$eq', '$in', '$gt', '$gte', '$lt', '$lte']);

function isOperator(value: unknown): value is WhereOperator {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function validateComparisonValue(value: unknown, path: string): void {
    if (!isComparisonValue(value)) throw new ValidationError(`${path} must be a JSON primitive`);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new ValidationError(`${path} must be finite`);
}

function compareOrdered(actual: unknown, expected: number | string, operator: '$gt' | '$gte' | '$lt' | '$lte'): boolean {
    if (typeof actual !== typeof expected || (typeof actual !== 'number' && typeof actual !== 'string')) return false;
    if (operator === '$gt') return actual > expected;
    if (operator === '$gte') return actual >= expected;
    if (operator === '$lt') return actual < expected;
    return actual <= expected;
}

export function validateWhere(where?: Where): void {
    if (!where) return;
    if (typeof where !== 'object' || Array.isArray(where)) throw new ValidationError('where must be an object');
    for (const [field, condition] of Object.entries(where)) {
        if (!field || field.includes('.')) throw new ValidationError('where only supports non-empty top-level metadata fields');
        if (Array.isArray(condition)) {
            condition.forEach((value, index) => validateComparisonValue(value, `where.${field}[${index}]`));
            continue;
        }
        if (!isOperator(condition)) {
            validateComparisonValue(condition, `where.${field}`);
            continue;
        }
        const entries = Object.entries(condition);
        if (entries.length === 0) throw new ValidationError(`where.${field} must contain an operator`);
        for (const [key, value] of entries) {
            if (!OPERATOR_KEYS.has(key)) throw new ValidationError(`Unsupported where operator: ${key}`);
            if (value === undefined) throw new ValidationError(`where.${field}.${key} is undefined`);
        }
        if (condition.$in !== undefined && !Array.isArray(condition.$in)) {
            throw new ValidationError('$in must be an array');
        }
        if (condition.$eq !== undefined) validateComparisonValue(condition.$eq, `where.${field}.$eq`);
        condition.$in?.forEach((value, index) => validateComparisonValue(value, `where.${field}.$in[${index}]`));
        for (const operator of ['$gt', '$gte', '$lt', '$lte'] as const) {
            const value = condition[operator];
            if (value !== undefined) {
                if (typeof value !== 'number' && typeof value !== 'string') {
                    throw new ValidationError(`where.${field}.${operator} must be a number or string`);
                }
                if (typeof value === 'number' && !Number.isFinite(value)) {
                    throw new ValidationError(`where.${field}.${operator} must be finite`);
                }
            }
        }
    }
}

export function matchesWhere(metadata: Metadata | undefined, where?: Where): boolean {
    if (!where) return true;
    const source = metadata ?? {};
    for (const [field, condition] of Object.entries(where)) {
        const actual = source[field];
        if (Array.isArray(condition)) {
            if (!condition.some((value) => Object.is(value, actual))) return false;
            continue;
        }
        if (!isOperator(condition)) {
            if (!Object.is(condition, actual)) return false;
            continue;
        }
        if (condition.$eq !== undefined && !Object.is(condition.$eq, actual)) return false;
        if (condition.$in !== undefined && !condition.$in.some((value) => Object.is(value, actual))) return false;
        for (const operator of ['$gt', '$gte', '$lt', '$lte'] as const) {
            const expected = condition[operator];
            if (expected !== undefined && !compareOrdered(actual, expected, operator)) return false;
        }
    }
    return true;
}

export function isComparisonValue(value: unknown): value is ComparisonValue {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}
