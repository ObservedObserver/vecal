import { serializeError } from './errors.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';
import { VectorDBRuntime } from './runtime.js';
import type { IndexBuildProgress } from './types.js';

interface WorkerScope {
    postMessage(message: WorkerResponse): void;
    addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
}

const scope = globalThis as unknown as WorkerScope;
const cancelled = new Set<number>();
const runtime = new VectorDBRuntime((status) => scope.postMessage({ type: 'status', status }));
let requestQueue = Promise.resolve();
let started = false;

// App-local wrapper Workers call this export so the runtime remains reachable
// when consumers honor the package-level `sideEffects: false` declaration.
export function startVecalWorker(): void {
    if (started) return;
    started = true;
    scope.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'cancel') {
            cancelled.add(message.id);
            return;
        }

        const context = {
            isCancelled: () => cancelled.has(message.id),
            onProgress: (progress: IndexBuildProgress) => {
                scope.postMessage({ type: 'progress', id: message.id, progress });
            },
        };

        requestQueue = requestQueue.then(async () => {
            try {
                const result = await runtime.execute(message.method, message.params, context);
                scope.postMessage({ type: 'response', id: message.id, ok: true, result, status: runtime.status() });
            } catch (error: unknown) {
                scope.postMessage({
                    type: 'response',
                    id: message.id,
                    ok: false,
                    error: serializeError(error),
                    status: runtime.status(),
                });
            } finally {
                cancelled.delete(message.id);
            }
        });
    });
}

startVecalWorker();
