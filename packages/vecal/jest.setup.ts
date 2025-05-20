import 'fake-indexeddb/auto';

// Polyfill for structuredClone if not available
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = function structuredClone(obj: any) {
    return JSON.parse(JSON.stringify(obj));
  };
} 