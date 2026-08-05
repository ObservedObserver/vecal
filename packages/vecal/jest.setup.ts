import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';

// Polyfill for structuredClone if not available
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = function structuredClone(obj: any) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (ArrayBuffer.isView(obj)) return obj.slice();
    if (obj instanceof ArrayBuffer) return obj.slice(0);
    if (Array.isArray(obj)) return obj.map((value) => structuredClone(value));
    return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, structuredClone(value)]));
  };
}

if (typeof globalThis.crypto.randomUUID !== 'function') {
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: randomUUID });
}
