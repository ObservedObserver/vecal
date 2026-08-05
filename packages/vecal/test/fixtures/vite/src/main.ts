import { VectorDB } from 'vecal';

document.querySelector<HTMLDivElement>('#app')!.textContent = 'Vecal consumer';

export async function openDatabase() {
    return VectorDB.open({ name: 'vite-consumer', dimension: 3, metric: 'cosine' });
}

document.querySelector<HTMLDivElement>('#app')!.addEventListener('click', () => {
    void (async () => {
        const database = await openDatabase();
        await database.clear();
        await database.add({ id: 'runtime', vector: new Float32Array([1, 0, 0]), metadata: { label: 'runtime' } });
        const [result] = await database.search(new Float32Array([1, 0, 0]), { k: 1, strategy: 'exact' });
        await database.close();
        document.querySelector<HTMLDivElement>('#app')!.textContent = `ready:${result.id}`;
    })().catch((error: unknown) => {
        document.querySelector<HTMLDivElement>('#app')!.textContent = `error:${error instanceof Error ? error.message : error}`;
    });
});
