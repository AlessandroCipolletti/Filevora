import { fail, isFileSdkError } from '../errors/error.js';
import {
  parseListQuery,
  type ListQueryInput,
  type ParsedListQuery,
} from '../server/list-query.js';
import type { SearchFilesInput } from '../types/index.js';
import { queryFingerprint, scoreToMicros } from './cursor.js';
import {
  SEARCH_MAX_RESULTS_CEILING,
  SEARCH_QUERY_MAX_CHARS,
} from './defaults.js';

export interface ParsedSearch {
  query: string;
  filters: ParsedListQuery;
  minScore: number;
  minScoreMicros: number;
  maxResults: number;
  limit: number;
  cursor: string | undefined;
  /** Everything a cursor must agree with, except the embedding model. */
  fingerprintParts: Record<string, unknown>;
}

const FILTER_KEYS = [
  'type',
  'createdFrom',
  'createdTo',
  'updatedFrom',
  'updatedTo',
  'visibility',
  'mime',
  'filename',
  'tags',
  'tagsAll',
  'tagCategory',
  'sizeMin',
  'sizeMax',
  'widthMin',
  'heightMin',
  'durationMin',
  'durationMax',
  'status',
  'preset',
] as const;

function invalid(message: string): never {
  throw fail('SEARCH_QUERY_INVALID', { message });
}

/** Validate a search body with the same filter rules as GET /files. */
export function parseSearchInput(
  input: SearchFilesInput,
  defaults: {
    minScore: number;
    maxResults: number;
    config: { metadata: { mode: string }; gemini: { apiKey: string } };
  },
): ParsedSearch {
  if (!input || typeof input !== 'object')
    invalid('The search body must be an object with a query.');
  if (typeof input.query !== 'string')
    invalid('query is required and must be a string.');
  const query = input.query.trim().replace(/\s+/g, ' ');
  if (query.length < 1 || query.length > SEARCH_QUERY_MAX_CHARS) {
    invalid(
      `query must be 1 to ${SEARCH_QUERY_MAX_CHARS} characters after trimming.`,
    );
  }
  const minScore = input.minScore ?? defaults.minScore;
  if (
    typeof minScore !== 'number' ||
    !Number.isFinite(minScore) ||
    minScore < 0 ||
    minScore > 1
  ) {
    invalid('minScore must be a number from 0 to 1.');
  }
  const maxResults = input.maxResults ?? defaults.maxResults;
  if (
    typeof maxResults !== 'number' ||
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > SEARCH_MAX_RESULTS_CEILING
  ) {
    invalid(
      `maxResults must be an integer from 1 to ${SEARCH_MAX_RESULTS_CEILING}.`,
    );
  }
  if (input.cursor !== undefined && typeof input.cursor !== 'string') {
    invalid('cursor must be the nextCursor string from a previous page.');
  }
  const listInput: ListQueryInput = {};
  const source = input as unknown as Record<string, unknown>;
  for (const key of FILTER_KEYS) {
    if (source[key] !== undefined) {
      (listInput as Record<string, unknown>)[key] = source[key];
    }
  }
  if (input.limit !== undefined) listInput.limit = input.limit;
  let filters: ParsedListQuery;
  try {
    filters = parseListQuery(listInput, defaults.config);
  } catch (error) {
    if (isFileSdkError(error) && error.code === 'LIST_QUERY_INVALID') {
      invalid(error.message);
    }
    throw error;
  }
  const scope: Record<string, unknown> = { ...filters };
  for (const key of ['limit', 'cursor', 'sort', 'order']) delete scope[key];
  const minScoreMicros = scoreToMicros(minScore);
  return {
    query,
    filters,
    minScore,
    minScoreMicros,
    maxResults,
    limit: filters.limit,
    cursor: input.cursor,
    fingerprintParts: { query, minScoreMicros, maxResults, filters: scope },
  };
}

export function fingerprintFor(
  parsed: ParsedSearch,
  model: string,
  dimensions: number,
): string {
  return queryFingerprint({ ...parsed.fingerprintParts, model, dimensions });
}
