import { VectorDB, SearchResult } from './index';

interface TestConfig {
  dbName: string;
  dimension: number;
}

// Type-safe logging function
const log = (msg: string | object): void => {
    // output.textContent += (typeof msg === 'object' ? JSON.stringify(msg) : msg) + '\n';
    console.log(msg);
};

// Test configuration
const TEST_CONFIG: TestConfig = {
    dbName: 'vector-db-test',
    dimension: 3
};

// Test vectors with proper typing
const VEC_APPLE: Float32Array = new Float32Array([0.9, 0.1, 0.1]);
const VEC_BANANA: Float32Array = new Float32Array([0.1, 0.9, 0.1]);
const VEC_CHERRY: Float32Array = new Float32Array([0.1, 0.1, 0.9]);
const QUERY_VEC: Float32Array = new Float32Array([0.85, 0.2, 0.15]);

async function runTests(): Promise<void> {
    try {
        // Initialize database with typed config
        const db = new VectorDB(TEST_CONFIG);
        log('✅ Database initialized successfully');

        // Test 1: Add vectors
        const id1 = await db.add(VEC_APPLE, { label: 'Apple' });
        const id2 = await db.add(VEC_BANANA, { label: 'Banana' });
        const id3 = await db.add(VEC_CHERRY, { label: 'Cherry' });
        log(`✅ Successfully added 3 vectors (IDs: ${id1}, ${id2}, ${id3})`);

        // Test 2: Similarity search
        const results = await db.search(QUERY_VEC, 2);
        if (results.length !== 2) throw new Error('Incorrect number of search results');
        if (results[0].id !== id1) throw new Error('Incorrect similarity ranking');
        log('✅ Similarity search test passed');
        log(`   Search results: ${JSON.stringify(results, null, 2)}`);

        // Test 3: Get entry
        const entry = await db.get(id2);
        if (!entry || entry.metadata?.label !== 'Banana') throw new Error('Failed to get entry');
        log('✅ Entry retrieval test passed');

        // Test 4: Update entry
        await db.update(id3, { metadata: { label: 'Updated Cherry' } });
        const updatedEntry = await db.get(id3);
        if (updatedEntry?.metadata?.label !== 'Updated Cherry') throw new Error('Update failed');
        log('✅ Entry update test passed');

        // Test 5: Delete entry
        await db.delete(id2);
        const deletedEntry = await db.get(id2);
        if (deletedEntry) throw new Error('Delete failed');
        log('✅ Entry deletion test passed');

        // Clean up test database
        indexedDB.deleteDatabase(TEST_CONFIG.dbName);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log(`❌ Test failed: ${errorMessage}`);
        console.error(error);
    }
}

// Execute tests
runTests().catch(error => {
    console.error('Test execution failed:', error);
});