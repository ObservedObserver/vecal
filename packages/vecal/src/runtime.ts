import {
    DatabaseClosedError,
    IndexBuildConflictError,
    IndexNotReadyError,
    OperationCancelledError,
    RecordConflictError,
    RecordNotFoundError,
    SchemaMismatchError,
    UnsupportedEnvironmentError,
    ValidationError,
} from './errors.js';
import { matchesWhere, validateWhere } from './filter.js';
import { HNSWIndex, type HNSWSnapshot } from './hnsw.js';
import { compareIds, metricScore } from './math.js';
import { TopK } from './top-k.js';
import type {
    EnsureIndexOptions,
    HNSWConfig,
    IndexBuildProgress,
    IndexState,
    IndexStatus,
    Metadata,
    Metric,
    SearchOptions,
    SearchResult,
    VectorInput,
    VectorRecord,
    VectorUpdate,
    Where,
} from './types.js';
import { generateId, prepareVector, validateK, validateMetadata, validateOpenOptions } from './validation.js';

const DATABASE_VERSION = 1;
const SCHEMA_VERSION = 1;
const META_STORE = 'meta';
const ENTRY_STORE = 'entries';
const SNAPSHOT_STORE = 'index_snapshots';
const SCHEMA_KEY = 'schema';
const SNAPSHOT_KEY = 'hnsw';
const TOMBSTONE_STALE_RATIO = 0.1;
const CHECKPOINT_DELAY_MS = 2_000;

interface SchemaRecord {
    key: typeof SCHEMA_KEY;
    schemaVersion: number;
    dimension: number;
    metric: Metric;
    revision: number;
}

interface StoredEntry extends VectorRecord<Metadata> {}

interface SnapshotRecord {
    key: typeof SNAPSHOT_KEY;
    revision: number;
    dimension: number;
    metric: Metric;
    config: HNSWConfig;
    snapshot: HNSWSnapshot;
}

interface OpenParams {
    name: string;
    dimension: number;
    metric: Metric;
}

export interface RuntimeContext {
    isCancelled: () => boolean;
    onProgress: (progress: IndexBuildProgress) => void;
}

type StatusListener = (status: IndexStatus) => void;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new DOMException('Transaction aborted', 'AbortError'));
    });
}

function assertFiniteOption(value: number | undefined, name: string): void {
    if (value !== undefined && !Number.isFinite(value)) throw new ValidationError(`${name} must be finite`);
}

export class VectorDBRuntime {
    private database?: IDBDatabase;
    private logicalName = '';
    private physicalName = '';
    private dimension = 0;
    private metric: Metric = 'cosine';
    private revision = 0;
    private state: IndexState = 'absent';
    private hnsw?: HNSWIndex;
    private broadcast?: BroadcastChannel;
    private checkpointTimer?: ReturnType<typeof setTimeout>;
    private checkpointPromise?: Promise<void>;
    private buildPromise?: Promise<void>;
    private closed = false;

    constructor(private readonly onStatus: StatusListener = () => undefined) {}

    status(): IndexStatus {
        return {
            state: this.closed ? 'closed' : this.state,
            revision: this.revision,
            nodeCount: this.hnsw?.liveCount ?? 0,
            tombstoneRatio: this.hnsw?.tombstoneRatio ?? 0,
            config: this.hnsw ? { ...this.hnsw.config } : undefined,
        };
    }

    async execute(method: string, params: unknown, context: RuntimeContext): Promise<unknown> {
        if (method !== 'open') this.assertOpen();
        this.throwIfCancelled(context);
        switch (method) {
            case 'open':
                return this.open(params as OpenParams);
            case 'add':
                return this.add(params as VectorInput);
            case 'addMany':
                return this.addMany(params as VectorInput[]);
            case 'upsert':
                return this.upsert(params as VectorInput & { id: string });
            case 'get':
                return this.get(params as string);
            case 'getMany':
                return this.getMany(params as string[]);
            case 'update': {
                const input = params as { id: string; patch: VectorUpdate };
                return this.update(input.id, input.patch);
            }
            case 'delete':
                return this.delete(params as string);
            case 'deleteMany':
                return this.deleteMany(params as string[]);
            case 'count':
                return this.count();
            case 'clear':
                return this.clear();
            case 'search': {
                const input = params as { query: Float32Array; options: Omit<SearchOptions, 'signal'> };
                return this.search(input.query, input.options, context);
            }
            case 'ensureIndex':
                return this.ensureIndex(params as Omit<EnsureIndexOptions, 'signal' | 'onProgress'>, context);
            case 'close':
                return this.close();
            default:
                throw new ValidationError(`Unknown worker method: ${method}`);
        }
    }

    async open(params: OpenParams): Promise<IndexStatus> {
        if (this.database && !this.closed) return this.status();
        validateOpenOptions(params.name, params.dimension, params.metric);
        if (typeof indexedDB === 'undefined') throw new UnsupportedEnvironmentError('Vecal requires IndexedDB');

        this.logicalName = params.name;
        this.physicalName = `vecal:${params.name}:v1`;
        this.dimension = params.dimension;
        this.metric = params.metric;
        this.closed = false;

        const database = await this.openDatabase(this.physicalName);
        this.database = database;
        database.onversionchange = () => {
            database.close();
            this.closed = true;
            this.state = 'closed';
            this.emitStatus();
        };

        try {
            const schema = await this.initializeSchema();
            this.revision = schema.revision;
            await this.restoreSnapshot();
            this.initializeBroadcast();
            this.emitStatus();
            return this.status();
        } catch (error) {
            database.close();
            this.database = undefined;
            this.closed = true;
            throw error;
        }
    }

    async add(input: VectorInput): Promise<string> {
        const [id] = await this.addMany([input]);
        return id;
    }

    async addMany(inputs: VectorInput[]): Promise<string[]> {
        await this.ensureRevision();
        if (!Array.isArray(inputs)) throw new ValidationError('addMany expects an array');
        if (inputs.length === 0) return [];
        const entries = inputs.map((input) => this.prepareEntry(input));
        const duplicateIds = new Set<string>();
        for (const entry of entries) {
            if (duplicateIds.has(entry.id)) throw new RecordConflictError(entry.id);
            duplicateIds.add(entry.id);
        }

        const transaction = this.db().transaction([ENTRY_STORE, META_STORE], 'readwrite');
        const entryStore = transaction.objectStore(ENTRY_STORE);
        const metaStore = transaction.objectStore(META_STORE);
        let previousRevision = this.revision;
        let conflictId: string | undefined;
        const schemaRequest = metaStore.get(SCHEMA_KEY) as IDBRequest<SchemaRecord>;
        schemaRequest.onsuccess = () => {
            const schema = this.assertSchema(schemaRequest.result);
            previousRevision = schema.revision;
            for (const entry of entries) {
                const request = entryStore.add(entry);
                request.onerror = () => {
                    conflictId ??= entry.id;
                };
            }
            metaStore.put({ ...schema, revision: schema.revision + 1 });
        };

        try {
            await transactionDone(transaction);
        } catch (error) {
            if (conflictId || (error instanceof DOMException && error.name === 'ConstraintError')) {
                throw new RecordConflictError(conflictId ?? 'unknown');
            }
            throw error;
        }
        this.afterMutation(previousRevision, previousRevision + 1, () => {
            for (const entry of entries) this.hnsw!.add(entry.id, entry.vector);
        });
        return entries.map((entry) => entry.id);
    }

    async upsert(input: VectorInput & { id: string }): Promise<string> {
        await this.ensureRevision();
        if (!input.id) throw new ValidationError('upsert requires an id');
        const entry = this.prepareEntry(input, true);
        const transaction = this.db().transaction([ENTRY_STORE, META_STORE], 'readwrite');
        const metaStore = transaction.objectStore(META_STORE);
        let previousRevision = this.revision;
        const schemaRequest = metaStore.get(SCHEMA_KEY) as IDBRequest<SchemaRecord>;
        schemaRequest.onsuccess = () => {
            const schema = this.assertSchema(schemaRequest.result);
            previousRevision = schema.revision;
            transaction.objectStore(ENTRY_STORE).put(entry);
            metaStore.put({ ...schema, revision: schema.revision + 1 });
        };
        await transactionDone(transaction);
        this.afterMutation(previousRevision, previousRevision + 1, () => this.hnsw!.add(entry.id, entry.vector));
        return entry.id;
    }

    async get(id: string): Promise<StoredEntry | undefined> {
        await this.ensureRevision();
        this.validateId(id);
        const transaction = this.db().transaction(ENTRY_STORE, 'readonly');
        return requestResult(transaction.objectStore(ENTRY_STORE).get(id) as IDBRequest<StoredEntry | undefined>);
    }

    async getMany(ids: string[]): Promise<(StoredEntry | undefined)[]> {
        await this.ensureRevision();
        if (!Array.isArray(ids)) throw new ValidationError('getMany expects an array');
        ids.forEach((id) => this.validateId(id));
        const transaction = this.db().transaction(ENTRY_STORE, 'readonly');
        const store = transaction.objectStore(ENTRY_STORE);
        return Promise.all(ids.map((id) => requestResult(store.get(id) as IDBRequest<StoredEntry | undefined>)));
    }

    async update(id: string, patch: VectorUpdate): Promise<void> {
        await this.ensureRevision();
        this.validateId(id);
        if (!patch || (patch.vector === undefined && !Object.prototype.hasOwnProperty.call(patch, 'metadata'))) {
            throw new ValidationError('update requires vector and/or metadata');
        }
        if (patch.metadata !== undefined) validateMetadata(patch.metadata);
        const preparedVector = patch.vector ? prepareVector(patch.vector, this.dimension, this.metric) : undefined;
        const transaction = this.db().transaction([ENTRY_STORE, META_STORE], 'readwrite');
        const entryStore = transaction.objectStore(ENTRY_STORE);
        const metaStore = transaction.objectStore(META_STORE);
        let previousRevision = this.revision;
        let notFound = false;
        let updatedEntry: StoredEntry | undefined;
        const schemaRequest = metaStore.get(SCHEMA_KEY) as IDBRequest<SchemaRecord>;
        schemaRequest.onsuccess = () => {
            const schema = this.assertSchema(schemaRequest.result);
            previousRevision = schema.revision;
            const getRequest = entryStore.get(id) as IDBRequest<StoredEntry | undefined>;
            getRequest.onsuccess = () => {
                if (!getRequest.result) {
                    notFound = true;
                    transaction.abort();
                    return;
                }
                updatedEntry = {
                    ...getRequest.result,
                    vector: preparedVector ?? getRequest.result.vector,
                };
                if (Object.prototype.hasOwnProperty.call(patch, 'metadata')) updatedEntry.metadata = patch.metadata;
                entryStore.put(updatedEntry);
                metaStore.put({ ...schema, revision: schema.revision + 1 });
            };
        };
        try {
            await transactionDone(transaction);
        } catch (error) {
            if (notFound) throw new RecordNotFoundError(id);
            throw error;
        }
        this.afterMutation(previousRevision, previousRevision + 1, () => {
            if (preparedVector) this.hnsw!.add(id, updatedEntry!.vector);
        });
    }

    async delete(id: string): Promise<boolean> {
        const deleted = await this.deleteMany([id]);
        return deleted > 0;
    }

    async deleteMany(ids: string[]): Promise<number> {
        await this.ensureRevision();
        if (!Array.isArray(ids)) throw new ValidationError('deleteMany expects an array');
        if (ids.length === 0) return 0;
        ids.forEach((id) => this.validateId(id));
        const uniqueIds = [...new Set(ids)];
        const transaction = this.db().transaction([ENTRY_STORE, META_STORE], 'readwrite');
        const entryStore = transaction.objectStore(ENTRY_STORE);
        const metaStore = transaction.objectStore(META_STORE);
        let previousRevision = this.revision;
        const deletedIds: string[] = [];
        const schemaRequest = metaStore.get(SCHEMA_KEY) as IDBRequest<SchemaRecord>;
        schemaRequest.onsuccess = () => {
            const schema = this.assertSchema(schemaRequest.result);
            previousRevision = schema.revision;
            let remaining = uniqueIds.length;
            for (const id of uniqueIds) {
                const getRequest = entryStore.get(id) as IDBRequest<StoredEntry | undefined>;
                getRequest.onsuccess = () => {
                    if (getRequest.result) {
                        deletedIds.push(id);
                        entryStore.delete(id);
                    }
                    remaining--;
                    if (remaining === 0 && deletedIds.length > 0) {
                        metaStore.put({ ...schema, revision: schema.revision + 1 });
                    }
                };
            }
        };
        await transactionDone(transaction);
        if (deletedIds.length > 0) {
            this.afterMutation(previousRevision, previousRevision + 1, () => {
                for (const id of deletedIds) this.hnsw!.markDeleted(id);
            });
        } else if (previousRevision !== this.revision) {
            this.invalidateIndex(previousRevision);
        }
        return deletedIds.length;
    }

    async count(): Promise<number> {
        await this.ensureRevision();
        const transaction = this.db().transaction(ENTRY_STORE, 'readonly');
        return requestResult(transaction.objectStore(ENTRY_STORE).count());
    }

    async clear(): Promise<void> {
        await this.ensureRevision();
        const transaction = this.db().transaction([ENTRY_STORE, META_STORE, SNAPSHOT_STORE], 'readwrite');
        const metaStore = transaction.objectStore(META_STORE);
        let previousRevision = this.revision;
        const schemaRequest = metaStore.get(SCHEMA_KEY) as IDBRequest<SchemaRecord>;
        schemaRequest.onsuccess = () => {
            const schema = this.assertSchema(schemaRequest.result);
            previousRevision = schema.revision;
            transaction.objectStore(ENTRY_STORE).clear();
            transaction.objectStore(SNAPSHOT_STORE).clear();
            metaStore.put({ ...schema, revision: schema.revision + 1 });
        };
        await transactionDone(transaction);
        this.cancelCheckpoint();
        this.hnsw = undefined;
        this.revision = previousRevision + 1;
        this.state = 'absent';
        this.broadcastRevision();
        this.emitStatus();
    }

    async search(
        queryInput: Float32Array,
        options: Omit<SearchOptions, 'signal'> = {},
        context: RuntimeContext
    ): Promise<SearchResult[]> {
        await this.ensureRevision();
        const query = prepareVector(queryInput, this.dimension, this.metric);
        const k = options.k ?? 10;
        const strategy = options.strategy ?? 'auto';
        const efSearch = options.efSearch ?? 64;
        validateK(k);
        if (!Number.isSafeInteger(efSearch) || efSearch <= 0) throw new ValidationError('efSearch must be a positive integer');
        assertFiniteOption(options.minScore, 'minScore');
        validateWhere(options.where as Where | undefined);

        if (strategy === 'exact' || (strategy === 'auto' && this.state !== 'ready')) {
            return this.exactSearch(query, k, options.where, options.minScore, context);
        }
        if (strategy !== 'auto' && strategy !== 'hnsw') throw new ValidationError(`Unsupported search strategy: ${strategy}`);
        if (this.state !== 'ready' || !this.hnsw) throw new IndexNotReadyError();

        const startRevision = this.revision;
        const results = await this.hnswSearch(query, k, efSearch, options.where, options.minScore, context);
        const changed = await this.ensureRevision();
        if (changed || this.revision !== startRevision) {
            return this.exactSearch(query, k, options.where, options.minScore, context);
        }
        return results;
    }

    async ensureIndex(options: Omit<EnsureIndexOptions, 'signal' | 'onProgress'>, context: RuntimeContext): Promise<void> {
        if (!options || options.type !== 'hnsw') throw new ValidationError('Only the hnsw index type is supported');
        if (this.buildPromise) return this.buildPromise;
        const config: HNSWConfig = {
            m: options.m ?? 16,
            efConstruction: options.efConstruction ?? 200,
            seed: (options.seed ?? 0x5eed1234) >>> 0,
        };
        // Constructor validation is shared with restore and incremental use.
        new HNSWIndex(this.dimension, this.metric, config);

        this.buildPromise = this.buildIndexWithRetry(config, context).finally(() => {
            this.buildPromise = undefined;
        });
        return this.buildPromise;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.cancelCheckpoint();
        if (this.state === 'ready' && this.hnsw) await this.checkpoint();
        if (this.checkpointPromise) await this.checkpointPromise;
        this.broadcast?.close();
        this.broadcast = undefined;
        this.database?.close();
        this.database = undefined;
        this.hnsw = undefined;
        this.closed = true;
        this.state = 'closed';
        this.emitStatus();
    }

    private async openDatabase(name: string): Promise<IDBDatabase> {
        return new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(name, DATABASE_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: 'key' });
                if (!database.objectStoreNames.contains(ENTRY_STORE)) database.createObjectStore(ENTRY_STORE, { keyPath: 'id' });
                if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
                    database.createObjectStore(SNAPSHOT_STORE, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
            request.onblocked = () => reject(new UnsupportedEnvironmentError('Opening the Vecal database was blocked'));
        });
    }

    private async initializeSchema(): Promise<SchemaRecord> {
        const transaction = this.db().transaction(META_STORE, 'readwrite');
        const store = transaction.objectStore(META_STORE);
        const request = store.get(SCHEMA_KEY) as IDBRequest<SchemaRecord | undefined>;
        let schema: SchemaRecord;
        request.onsuccess = () => {
            schema = request.result ?? {
                key: SCHEMA_KEY,
                schemaVersion: SCHEMA_VERSION,
                dimension: this.dimension,
                metric: this.metric,
                revision: 0,
            };
            if (!request.result) store.add(schema);
        };
        await transactionDone(transaction);
        return this.assertSchema(schema!);
    }

    private assertSchema(schema: SchemaRecord | undefined): SchemaRecord {
        if (!schema || schema.schemaVersion !== SCHEMA_VERSION) {
            throw new SchemaMismatchError('Unsupported or missing Vecal schema');
        }
        if (schema.dimension !== this.dimension || schema.metric !== this.metric) {
            throw new SchemaMismatchError(
                `Database "${this.logicalName}" uses dimension=${schema.dimension}, metric=${schema.metric}; ` +
                    `requested dimension=${this.dimension}, metric=${this.metric}`
            );
        }
        return schema;
    }

    private async readSchema(): Promise<SchemaRecord> {
        const transaction = this.db().transaction(META_STORE, 'readonly');
        return this.assertSchema(
            await requestResult(transaction.objectStore(META_STORE).get(SCHEMA_KEY) as IDBRequest<SchemaRecord | undefined>)
        );
    }

    private async ensureRevision(): Promise<boolean> {
        const schema = await this.readSchema();
        if (schema.revision === this.revision) return false;
        this.invalidateIndex(schema.revision);
        return true;
    }

    private invalidateIndex(revision: number): void {
        const hadIndex = this.state !== 'absent' || this.hnsw !== undefined;
        this.cancelCheckpoint();
        this.hnsw = undefined;
        this.revision = revision;
        this.state = hadIndex ? 'stale' : 'absent';
        this.emitStatus();
    }

    private afterMutation(previousRevision: number, nextRevision: number, mutateIndex: () => void): void {
        if (previousRevision !== this.revision) this.invalidateIndex(previousRevision);
        this.revision = nextRevision;
        if (this.state === 'ready' && this.hnsw) {
            mutateIndex();
            if (this.hnsw.tombstoneRatio > TOMBSTONE_STALE_RATIO) {
                this.cancelCheckpoint();
                this.state = 'stale';
            } else {
                this.scheduleCheckpoint();
            }
        }
        this.broadcastRevision();
        this.emitStatus();
    }

    private prepareEntry(input: VectorInput, requireId = false): StoredEntry {
        if (!input || typeof input !== 'object') throw new ValidationError('vector entry must be an object');
        if (requireId && !input.id) throw new ValidationError('id is required');
        const id = input.id ?? generateId();
        this.validateId(id);
        validateMetadata(input.metadata);
        return {
            id,
            vector: prepareVector(input.vector, this.dimension, this.metric),
            metadata: input.metadata,
        };
    }

    private validateId(id: string): void {
        if (typeof id !== 'string' || !id) throw new ValidationError('id must be a non-empty string');
    }

    private async exactSearch(
        query: Float32Array,
        k: number,
        where: Where | undefined,
        minScore: number | undefined,
        context: RuntimeContext
    ): Promise<SearchResult[]> {
        const transaction = this.db().transaction(ENTRY_STORE, 'readonly');
        const store = transaction.objectStore(ENTRY_STORE);
        const top = new TopK<SearchResult>(k);
        let cancelled = false;
        let result: SearchResult[] = [];

        return new Promise<SearchResult[]>((resolve, reject) => {
            const cursorRequest = store.openCursor();
            cursorRequest.onsuccess = () => {
                if (context.isCancelled()) {
                    cancelled = true;
                    transaction.abort();
                    return;
                }
                const cursor = cursorRequest.result;
                if (!cursor) {
                    result = top.values();
                    return;
                }
                const entry = cursor.value as StoredEntry;
                if (matchesWhere(entry.metadata, where)) {
                    const score = metricScore(this.metric, query, entry.vector);
                    if (minScore === undefined || score >= minScore) {
                        const value = { id: entry.id, score, metadata: entry.metadata };
                        top.push({ value, score, tieBreaker: entry.id });
                    }
                }
                cursor.continue();
            };
            cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Exact search cursor failed'));
            transaction.oncomplete = () => resolve(result);
            transaction.onabort = () => reject(cancelled ? new OperationCancelledError() : transaction.error);
            transaction.onerror = () => reject(transaction.error ?? new Error('Exact search failed'));
        });
    }

    private async hnswSearch(
        query: Float32Array,
        k: number,
        efSearch: number,
        where: Where | undefined,
        minScore: number | undefined,
        context: RuntimeContext
    ): Promise<SearchResult[]> {
        const index = this.hnsw!;
        let candidateLimit = where ? Math.min(index.liveCount, Math.max(k * 5, k + 10)) : k;
        while (true) {
            this.throwIfCancelled(context);
            const candidates = await index.searchAsync(
                query,
                candidateLimit,
                Math.max(efSearch, candidateLimit),
                context.isCancelled
            );
            const records = await this.fetchEntries(candidates.map((candidate) => candidate.id));
            const byId = new Map(records.filter(Boolean).map((entry) => [entry!.id, entry!]));
            const results = candidates
                .filter((candidate) => {
                    const entry = byId.get(candidate.id);
                    return entry && matchesWhere(entry.metadata, where) && (minScore === undefined || candidate.score >= minScore);
                })
                .map((candidate) => {
                    const entry = byId.get(candidate.id)!;
                    return { id: candidate.id, score: candidate.score, metadata: entry.metadata };
                })
                .sort((left, right) => right.score - left.score || compareIds(left.id, right.id));

            if (!where || results.length >= k) return results.slice(0, k);
            if (candidateLimit >= index.liveCount) break;
            candidateLimit = Math.min(index.liveCount, Math.max(candidateLimit + 1, candidateLimit * 2));
        }
        return this.exactSearch(query, k, where, minScore, context);
    }

    private async fetchEntries(ids: string[]): Promise<(StoredEntry | undefined)[]> {
        const transaction = this.db().transaction(ENTRY_STORE, 'readonly');
        const store = transaction.objectStore(ENTRY_STORE);
        return Promise.all(ids.map((id) => requestResult(store.get(id) as IDBRequest<StoredEntry | undefined>)));
    }

    private async readAllEntries(context: RuntimeContext): Promise<StoredEntry[]> {
        const transaction = this.db().transaction(ENTRY_STORE, 'readonly');
        const entries: StoredEntry[] = [];
        let cancelled = false;
        return new Promise<StoredEntry[]>((resolve, reject) => {
            const request = transaction.objectStore(ENTRY_STORE).openCursor();
            request.onsuccess = () => {
                if (context.isCancelled()) {
                    cancelled = true;
                    transaction.abort();
                    return;
                }
                const cursor = request.result;
                if (!cursor) return;
                entries.push(cursor.value as StoredEntry);
                cursor.continue();
            };
            request.onerror = () => reject(request.error ?? new Error('Failed to read entries'));
            transaction.oncomplete = () => resolve(entries);
            transaction.onabort = () => reject(cancelled ? new OperationCancelledError() : transaction.error);
            transaction.onerror = () => reject(transaction.error ?? new Error('Failed to read entries'));
        });
    }

    private async buildIndexWithRetry(config: HNSWConfig, context: RuntimeContext): Promise<void> {
        const previousState = this.state;
        this.state = 'building';
        this.emitStatus();
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                this.throwIfCancelled(context);
                await this.ensureRevision();
                const buildRevision = this.revision;
                const entries = await this.readAllEntries(context);
                const index = new HNSWIndex(this.dimension, this.metric, config);
                await index.build(entries, {
                    isCancelled: context.isCancelled,
                    onProgress: context.onProgress,
                });
                const schema = await this.readSchema();
                if (schema.revision !== buildRevision) {
                    this.revision = schema.revision;
                    if (attempt === 0) continue;
                    throw new IndexBuildConflictError();
                }
                this.hnsw = index;
                this.revision = buildRevision;
                this.state = 'ready';
                await this.checkpoint();
                this.emitStatus();
                return;
            }
        } catch (error) {
            this.hnsw = undefined;
            this.state = previousState === 'ready' ? 'stale' : previousState;
            this.emitStatus();
            throw error;
        }
    }

    private async restoreSnapshot(): Promise<void> {
        const transaction = this.db().transaction(SNAPSHOT_STORE, 'readonly');
        const record = await requestResult(
            transaction.objectStore(SNAPSHOT_STORE).get(SNAPSHOT_KEY) as IDBRequest<SnapshotRecord | undefined>
        );
        if (!record) {
            this.state = 'absent';
            return;
        }
        if (
            record.revision !== this.revision ||
            record.dimension !== this.dimension ||
            record.metric !== this.metric ||
            record.snapshot.dimension !== this.dimension ||
            record.snapshot.metric !== this.metric
        ) {
            this.state = 'stale';
            return;
        }
        try {
            this.hnsw = HNSWIndex.deserialize(record.snapshot);
            this.state = 'ready';
        } catch {
            this.hnsw = undefined;
            this.state = 'stale';
        }
    }

    private scheduleCheckpoint(): void {
        this.cancelCheckpoint();
        this.checkpointTimer = setTimeout(() => {
            this.checkpointTimer = undefined;
            this.checkpointPromise = this.checkpoint().finally(() => {
                this.checkpointPromise = undefined;
            });
        }, CHECKPOINT_DELAY_MS);
    }

    private cancelCheckpoint(): void {
        if (this.checkpointTimer !== undefined) clearTimeout(this.checkpointTimer);
        this.checkpointTimer = undefined;
    }

    private async checkpoint(): Promise<void> {
        if (this.state !== 'ready' || !this.hnsw || this.closed) return;
        const revision = this.revision;
        const snapshot = this.hnsw.serialize();
        const schema = await this.readSchema();
        if (schema.revision !== revision || this.state !== 'ready') return;
        const record: SnapshotRecord = {
            key: SNAPSHOT_KEY,
            revision,
            dimension: this.dimension,
            metric: this.metric,
            config: { ...this.hnsw.config },
            snapshot,
        };
        const transaction = this.db().transaction(SNAPSHOT_STORE, 'readwrite');
        transaction.objectStore(SNAPSHOT_STORE).put(record);
        await transactionDone(transaction);
    }

    private initializeBroadcast(): void {
        if (typeof BroadcastChannel === 'undefined') return;
        this.broadcast = new BroadcastChannel(`${this.physicalName}:revision`);
        this.broadcast.onmessage = (event: MessageEvent<{ revision?: number }>) => {
            const externalRevision = event.data?.revision;
            if (typeof externalRevision === 'number' && externalRevision > this.revision) {
                this.invalidateIndex(externalRevision);
            }
        };
    }

    private broadcastRevision(): void {
        this.broadcast?.postMessage({ revision: this.revision });
    }

    private emitStatus(): void {
        this.onStatus(this.status());
    }

    private throwIfCancelled(context: RuntimeContext): void {
        if (context.isCancelled()) throw new OperationCancelledError();
    }

    private assertOpen(): void {
        if (this.closed || !this.database) throw new DatabaseClosedError();
    }

    private db(): IDBDatabase {
        this.assertOpen();
        return this.database!;
    }
}
