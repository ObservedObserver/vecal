import assert from 'node:assert/strict';
import { UnsupportedEnvironmentError, VectorDB } from 'vecal';

assert.equal(typeof VectorDB.open, 'function');
assert.equal(new UnsupportedEnvironmentError().code, 'UNSUPPORTED_ENVIRONMENT');
console.log('native ESM import passed');
