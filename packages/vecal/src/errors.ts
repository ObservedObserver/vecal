export type VecalErrorCode =
    | 'UNSUPPORTED_ENVIRONMENT'
    | 'SCHEMA_MISMATCH'
    | 'RECORD_CONFLICT'
    | 'RECORD_NOT_FOUND'
    | 'INDEX_NOT_READY'
    | 'INDEX_BUILD_CONFLICT'
    | 'OPERATION_CANCELLED'
    | 'DATABASE_CLOSED'
    | 'VALIDATION_ERROR'
    | 'INTERNAL_ERROR';

export class VecalError extends Error {
    readonly code: VecalErrorCode;

    constructor(code: VecalErrorCode, message: string) {
        super(message);
        this.name = 'VecalError';
        this.code = code;
    }
}

export class UnsupportedEnvironmentError extends VecalError {
    constructor(message = 'Vecal requires IndexedDB and Dedicated Worker support') {
        super('UNSUPPORTED_ENVIRONMENT', message);
        this.name = 'UnsupportedEnvironmentError';
    }
}

export class SchemaMismatchError extends VecalError {
    constructor(message: string) {
        super('SCHEMA_MISMATCH', message);
        this.name = 'SchemaMismatchError';
    }
}

export class RecordConflictError extends VecalError {
    constructor(id: string, message = `A vector with id "${id}" already exists`) {
        super('RECORD_CONFLICT', message);
        this.name = 'RecordConflictError';
    }
}

export class RecordNotFoundError extends VecalError {
    constructor(id: string, message = `No vector exists with id "${id}"`) {
        super('RECORD_NOT_FOUND', message);
        this.name = 'RecordNotFoundError';
    }
}

export class IndexNotReadyError extends VecalError {
    constructor(message = 'The HNSW index is not ready; call ensureIndex() first') {
        super('INDEX_NOT_READY', message);
        this.name = 'IndexNotReadyError';
    }
}

export class IndexBuildConflictError extends VecalError {
    constructor() {
        super('INDEX_BUILD_CONFLICT', 'The database changed repeatedly while the HNSW index was being built');
        this.name = 'IndexBuildConflictError';
    }
}

export class OperationCancelledError extends VecalError {
    constructor() {
        super('OPERATION_CANCELLED', 'The operation was cancelled');
        this.name = 'OperationCancelledError';
    }
}

export class DatabaseClosedError extends VecalError {
    constructor() {
        super('DATABASE_CLOSED', 'Database is closed');
        this.name = 'DatabaseClosedError';
    }
}

export class ValidationError extends VecalError {
    constructor(message: string) {
        super('VALIDATION_ERROR', message);
        this.name = 'ValidationError';
    }
}

export interface SerializedError {
    name: string;
    code: VecalErrorCode;
    message: string;
}

export function serializeError(error: unknown): SerializedError {
    if (error instanceof VecalError) {
        return { name: error.name, code: error.code, message: error.message };
    }
    if (error instanceof Error) {
        return { name: error.name, code: 'INTERNAL_ERROR', message: error.message };
    }
    return { name: 'Error', code: 'INTERNAL_ERROR', message: String(error) };
}

export function reviveError(error: SerializedError): VecalError {
    switch (error.code) {
        case 'UNSUPPORTED_ENVIRONMENT':
            return new UnsupportedEnvironmentError(error.message);
        case 'SCHEMA_MISMATCH':
            return new SchemaMismatchError(error.message);
        case 'RECORD_CONFLICT':
            return new RecordConflictError('unknown', error.message);
        case 'RECORD_NOT_FOUND':
            return new RecordNotFoundError('unknown', error.message);
        case 'INDEX_NOT_READY':
            return new IndexNotReadyError(error.message);
        case 'INDEX_BUILD_CONFLICT':
            return new IndexBuildConflictError();
        case 'OPERATION_CANCELLED':
            return new OperationCancelledError();
        case 'DATABASE_CLOSED':
            return new DatabaseClosedError();
        case 'VALIDATION_ERROR':
            return new ValidationError(error.message);
        default:
            return new VecalError('INTERNAL_ERROR', error.message);
    }
}
