export type {
  ErrorAction,
  ErrorCategory,
  ErrorCode,
  ErrorResolution,
  ErrorSpec,
} from './catalog.js';
export { ERROR_CATALOG, ERROR_CATEGORIES, ERROR_CODES } from './catalog.js';
export type { FileSdkErrorBody } from './error.js';
export {
  createRequestId,
  FileSdkError,
  fail,
  isFileSdkError,
} from './error.js';
