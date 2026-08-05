import Link from 'next/link';

export const metadata = {
  title: 'Vecal',
  description: 'Browser-native vector search powered by IndexedDB.',
};

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-16 md:grid-cols-[1.05fr_0.95fr] md:items-center md:py-24">
        <div>
          <p className="mb-3 text-sm font-medium text-fd-muted-foreground">
            Browser-native vector search
          </p>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-normal text-fd-foreground md:text-6xl">
            Vecal
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-fd-muted-foreground md:text-lg">
            An ESM-only, zero-dependency vector database with IndexedDB durability and
            Worker-hosted Exact and HNSW search.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/docs"
              className="inline-flex min-h-10 items-center rounded-md bg-fd-primary px-4 text-sm font-medium text-fd-primary-foreground"
            >
              Start with the guide
            </Link>
            <Link
              href="/docs/algorithms"
              className="inline-flex min-h-10 items-center rounded-md border px-4 text-sm font-medium text-fd-foreground"
            >
              Understand retrieval
            </Link>
          </div>
        </div>

        <div className="rounded-lg border bg-fd-card text-fd-card-foreground shadow-sm">
          <div className="border-b px-4 py-3 text-sm font-medium">Quick search flow</div>
          <pre className="overflow-x-auto p-4 text-sm leading-6">
            <code>{`import { VectorDB } from 'vecal';

const db = await VectorDB.open({
  name: 'docs-search',
  dimension: 3,
  metric: 'cosine',
});

await db.add({
  vector: new Float32Array([0.91, 0.12, 0.04]),
  metadata: { title: 'Vector indexing' },
});

await db.ensureIndex({ type: 'hnsw' });

const results = await db.search(
  new Float32Array([0.88, 0.18, 0.07]),
  { k: 5, strategy: 'auto' },
);`}</code>
          </pre>
        </div>
      </section>

      <section className="border-t bg-fd-muted/30">
        <div className="mx-auto grid max-w-6xl gap-4 px-6 py-10 md:grid-cols-3">
          {[
            ['Correct by default', 'Auto falls back to streaming Exact whenever HNSW is not ready.'],
            ['Worker owned', 'Storage, indexing, and retrieval stay away from main-thread compute.'],
            ['Durable acceleration', 'Revision-matched typed-array HNSW snapshots restore after refresh.'],
          ].map(([title, description]) => (
            <div key={title} className="rounded-lg border bg-fd-background p-5">
              <h2 className="text-base font-semibold">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{description}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
