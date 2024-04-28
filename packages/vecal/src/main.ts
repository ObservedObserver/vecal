import { VectorStore } from './vec-store';

const vectorStore = new VectorStore();

async function runDemo() {
    try {
        await vectorStore.init();
        await vectorStore.addVector('vec1', [0.1, 0.2, 0.3]);
        const vector = await vectorStore.getVector('vec1');
        console.log('Retrieved vector:', vector);
    } catch (error) {
        console.error('Error:', error);
    }
}

runDemo();
