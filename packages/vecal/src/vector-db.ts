import {
    DatabaseClosedError,
    OperationCancelledError,
    UnsupportedEnvironmentError,
    ValidationError,
    reviveError,
} from './errors.js';
import type { RpcMethod, WorkerResponse } from './protocol.js';
import type {
    EnsureIndexOptions,
    IndexBuildProgress,
    IndexStatus,
    Metadata,
    SearchOptions,
    SearchResult,
    VectorDBOpenOptions,
    VectorInput,
    VectorRecord,
    VectorUpdate,
    WorkerLike,
} from './types.js';
import { validateOpenOptions } from './validation.js';

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    onProgress?: (progress: IndexBuildProgress) => void;
    signal?: AbortSignal;
    abortHandler?: () => void;
}

export class VectorDB<M extends Metadata = Metadata> {
    private requestId = 0;
    private pending = new Map<number, PendingRequest>();
    private closed = false;
    private currentStatus: IndexStatus = {
        state: 'absent',
        revision: 0,
        nodeCount: 0,
        tombstoneRatio: 0,
    };

    private readonly messageListener = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data);
    private readonly errorListener = (event: ErrorEvent) => {
        const location = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
        const detail = event.error instanceof Error ? event.error.message : event.message;
        const error = new UnsupportedEnvironmentError(`${detail || 'The Vecal worker failed to start'}${location}`);
        for (const request of this.pending.values()) {
            if (request.signal && request.abortHandler) request.signal.removeEventListener('abort', request.abortHandler);
            request.reject(error);
        }
        this.pending.clear();
        this.closed = true;
        this.currentStatus = { ...this.currentStatus, state: 'closed' };
        this.disposeWorker();
    };

    private constructor(private readonly worker: WorkerLike) {
        worker.addEventListener('message', this.messageListener as (event: MessageEvent) => void);
        worker.addEventListener('error', this.errorListener);
    }

    static async open<M extends Metadata = Metadata>(options: VectorDBOpenOptions): Promise<VectorDB<M>> {
        validateOpenOptions(options.name, options.dimension, options.metric);
        if (options.workerUrl && options.workerFactory) {
            throw new ValidationError('workerUrl and workerFactory are mutually exclusive');
        }
        let worker: WorkerLike;
        try {
            if (options.workerFactory) {
                worker = options.workerFactory();
            } else {
                if (typeof Worker === 'undefined') throw new UnsupportedEnvironmentError();
                worker = options.workerUrl
                    ? new Worker(options.workerUrl, { type: 'module', name: `vecal:${options.name}` })
                    : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
            }
        } catch (error) {
            if (error instanceof UnsupportedEnvironmentError) throw error;
            throw new UnsupportedEnvironmentError(error instanceof Error ? error.message : String(error));
        }
        const database = new VectorDB<M>(worker);
        try {
            await database.request('open', {
                name: options.name,
                dimension: options.dimension,
                metric: options.metric,
            });
            return database;
        } catch (error) {
            database.disposeWorker();
            throw error;
        }
    }

    async add(input: VectorInput<M>): Promise<string> {
        return this.request<string>('add', input);
    }

    async addMany(inputs: VectorInput<M>[]): Promise<string[]> {
        return this.request<string[]>('addMany', inputs);
    }

    async upsert(input: VectorInput<M> & { id: string }): Promise<string> {
        return this.request<string>('upsert', input);
    }

    async get(id: string): Promise<VectorRecord<M> | undefined> {
        return this.request<VectorRecord<M> | undefined>('get', id);
    }

    async getMany(ids: string[]): Promise<(VectorRecord<M> | undefined)[]> {
        return this.request<(VectorRecord<M> | undefined)[]>('getMany', ids);
    }

    async update(id: string, patch: VectorUpdate<M>): Promise<void> {
        await this.request('update', { id, patch });
    }

    async delete(id: string): Promise<boolean> {
        return this.request<boolean>('delete', id);
    }

    async deleteMany(ids: string[]): Promise<number> {
        return this.request<number>('deleteMany', ids);
    }

    async count(): Promise<number> {
        return this.request<number>('count', undefined);
    }

    async clear(): Promise<void> {
        await this.request('clear', undefined);
    }

    async search(query: Float32Array, options: SearchOptions<M> = {}): Promise<SearchResult<M>[]> {
        const { signal, ...workerOptions } = options;
        return this.request<SearchResult<M>[]>('search', { query, options: workerOptions }, signal);
    }

    async ensureIndex(options: EnsureIndexOptions): Promise<void> {
        const { signal, onProgress, ...workerOptions } = options;
        await this.request('ensureIndex', workerOptions, signal, onProgress);
    }

    indexStatus(): IndexStatus {
        return {
            ...this.currentStatus,
            config: this.currentStatus.config ? { ...this.currentStatus.config } : undefined,
        };
    }

    async close(): Promise<void> {
        if (this.closed) return;
        try {
            await this.request('close', undefined);
        } finally {
            this.closed = true;
            this.currentStatus = { ...this.currentStatus, state: 'closed' };
            this.disposeWorker();
        }
    }

    private request<T = void>(
        method: RpcMethod,
        params: unknown,
        signal?: AbortSignal,
        onProgress?: (progress: IndexBuildProgress) => void
    ): Promise<T> {
        if (this.closed) return Promise.reject(new DatabaseClosedError());
        if (signal?.aborted) return Promise.reject(new OperationCancelledError());
        const id = ++this.requestId;
        return new Promise<T>((resolve, reject) => {
            const pending: PendingRequest = {
                resolve: resolve as (value: unknown) => void,
                reject,
                onProgress,
                signal,
            };
            if (signal) {
                pending.abortHandler = () => {
                    try {
                        this.worker.postMessage({ type: 'cancel', id });
                    } catch {
                        // The original request still rejects as a cancellation.
                    }
                    this.pending.delete(id);
                    reject(new OperationCancelledError());
                };
                signal.addEventListener('abort', pending.abortHandler, { once: true });
            }
            this.pending.set(id, pending);
            try {
                this.worker.postMessage({ type: 'request', id, method, params });
            } catch (error) {
                this.pending.delete(id);
                if (pending.signal && pending.abortHandler) pending.signal.removeEventListener('abort', pending.abortHandler);
                reject(
                    new ValidationError(
                        `The request could not be transferred to the Vecal worker: ${
                            error instanceof Error ? error.message : String(error)
                        }`
                    )
                );
            }
        });
    }

    private handleMessage(message: WorkerResponse): void {
        if (message.type === 'status') {
            this.currentStatus = message.status;
            return;
        }
        if (message.type === 'progress') {
            this.pending.get(message.id)?.onProgress?.(message.progress);
            return;
        }
        this.currentStatus = message.status;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (pending.signal && pending.abortHandler) pending.signal.removeEventListener('abort', pending.abortHandler);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(reviveError(message.error));
    }

    private disposeWorker(): void {
        this.worker.removeEventListener('message', this.messageListener as (event: MessageEvent) => void);
        this.worker.removeEventListener('error', this.errorListener);
        this.worker.terminate();
        for (const request of this.pending.values()) {
            if (request.signal && request.abortHandler) request.signal.removeEventListener('abort', request.abortHandler);
            request.reject(new DatabaseClosedError());
        }
        this.pending.clear();
    }
}
