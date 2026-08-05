import type { SerializedError } from './errors.js';
import type { IndexBuildProgress, IndexStatus } from './types.js';

export type RpcMethod =
    | 'open'
    | 'add'
    | 'addMany'
    | 'upsert'
    | 'get'
    | 'getMany'
    | 'update'
    | 'delete'
    | 'deleteMany'
    | 'count'
    | 'clear'
    | 'search'
    | 'ensureIndex'
    | 'close';

export interface RpcRequest {
    type: 'request';
    id: number;
    method: RpcMethod;
    params: unknown;
}

export interface RpcCancel {
    type: 'cancel';
    id: number;
}

export type WorkerRequest = RpcRequest | RpcCancel;

export interface RpcSuccess {
    type: 'response';
    id: number;
    ok: true;
    result: unknown;
    status: IndexStatus;
}

export interface RpcFailure {
    type: 'response';
    id: number;
    ok: false;
    error: SerializedError;
    status: IndexStatus;
}

export interface RpcProgress {
    type: 'progress';
    id: number;
    progress: IndexBuildProgress;
}

export interface RpcStatus {
    type: 'status';
    status: IndexStatus;
}

export type WorkerResponse = RpcSuccess | RpcFailure | RpcProgress | RpcStatus;
