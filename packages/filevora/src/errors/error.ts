import { redactValue } from '../redact.js';
import {
  ERROR_CATALOG,
  type ErrorCategory,
  type ErrorCode,
  type ErrorResolution,
} from './catalog.js';

export interface FileSdkErrorBody {
  code: string;
  message: string;
  category: ErrorCategory;
  retryable: boolean;
  requestId: string;
  context?: Record<string, unknown>;
  resolution?: ErrorResolution;
}

/**
 * Structured error returned by every public Filevora entry point.
 * `toJSON()` is safe to send to a browser: it has no stack and redacted context.
 */
export class FileSdkError extends Error implements FileSdkErrorBody {
  readonly code: ErrorCode | string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly context?: Record<string, unknown>;
  readonly resolution?: ErrorResolution;
  readonly httpStatus: number;

  constructor(init: {
    code: ErrorCode | string;
    message: string;
    category: ErrorCategory;
    retryable: boolean;
    requestId?: string;
    context?: Record<string, unknown>;
    resolution?: ErrorResolution;
    httpStatus?: number;
  }) {
    super(init.message);
    this.name = 'FileSdkError';
    this.code = init.code;
    this.category = init.category;
    this.retryable = init.retryable;
    this.requestId = init.requestId ?? createRequestId();
    const redacted = init.context ? redactValue(init.context) : undefined;
    if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
      this.context = redacted as Record<string, unknown>;
    }
    this.resolution = init.resolution;
    this.httpStatus = init.httpStatus ?? 500;
  }

  toJSON(): FileSdkErrorBody {
    return {
      code: this.code,
      message: this.message,
      category: this.category,
      retryable: this.retryable,
      requestId: this.requestId,
      ...(this.context ? { context: this.context } : {}),
      ...(this.resolution ? { resolution: this.resolution } : {}),
    };
  }
}

export function isFileSdkError(value: unknown): value is FileSdkError {
  return value instanceof FileSdkError;
}

export function createRequestId(): string {
  const cryptoApi = globalThis.crypto;
  const raw =
    cryptoApi?.randomUUID?.() ??
    `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `req_${raw.replace(/-/g, '')}`;
}

/** Build a catalog error. Context is redacted and size-bounded. */
export function fail(
  code: ErrorCode,
  extras?: {
    message?: string;
    context?: Record<string, unknown>;
    requestId?: string;
  },
): FileSdkError {
  const spec = ERROR_CATALOG[code];
  return new FileSdkError({
    code,
    message: extras?.message ?? spec.message,
    category: spec.category,
    retryable: spec.retryable,
    httpStatus: spec.httpStatus,
    resolution: spec.resolution,
    ...(extras?.requestId ? { requestId: extras.requestId } : {}),
    ...(extras?.context ? { context: extras.context } : {}),
  });
}
