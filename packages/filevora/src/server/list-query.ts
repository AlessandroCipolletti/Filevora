import { fail } from '../errors/error.js';

export const ASSET_TYPES = ['image', 'video', 'document', 'audio'] as const;
export const SORT_FIELDS = ['created', 'updated', 'size', 'filename'] as const;
export const SORT_ORDERS = ['asc', 'desc'] as const;
export const DESCRIPTION_STATUSES = ['pending', 'done', 'failed'] as const;
export const PROCESSING_STATUSES = [
  'none',
  'queued',
  'processing',
  'ready',
  'failed',
  'partially_ready',
  'retrying',
  'quarantined',
] as const;
export const TAG_CATEGORIES = [
  'subject',
  'action',
  'style',
  'purpose',
  'emotion',
  'kind',
  'language',
] as const;

export type AssetType = (typeof ASSET_TYPES)[number];
export type SortField = (typeof SORT_FIELDS)[number];
export type SortOrder = (typeof SORT_ORDERS)[number];

export interface ListQueryInput {
  limit?: number;
  cursor?: string;
  kind?: string;
  type?: string | string[];
  types?: string | string[];
  createdFrom?: string;
  createdTo?: string;
  createdAfter?: string;
  updatedFrom?: string;
  updatedTo?: string;
  tag?: string | string[];
  tags?: string | string[];
  tagsAll?: string | string[];
  tagCategory?: string;
  q?: string;
  mime?: string;
  filename?: string;
  sizeMin?: number;
  sizeMax?: number;
  durationMin?: number;
  durationMax?: number;
  widthMin?: number;
  heightMin?: number;
  status?: string;
  processingStatus?: string;
  descriptionStatus?: string;
  visibility?: string;
  preset?: string;
  hasDescription?: boolean;
  sort?: string;
  order?: string;
}

export interface TagFilter {
  tag: string;
  category?: string;
}

export interface ParsedListQuery {
  limit: number;
  cursor: { value: string; id: string } | null;
  types: AssetType[];
  kind?: string;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  tags: TagFilter[];
  tagsAll: TagFilter[];
  tagCategory?: string;
  words: string[];
  mime?: string;
  filename?: string;
  sizeMin?: number;
  sizeMax?: number;
  durationMin?: number;
  durationMax?: number;
  widthMin?: number;
  heightMin?: number;
  processingStatus?: string;
  descriptionStatus?: (typeof DESCRIPTION_STATUSES)[number];
  visibility?: 'public' | 'private';
  preset?: string;
  hasDescription?: boolean;
  sort: SortField;
  order: SortOrder;
}

const SORT_COLUMN = {
  created: 'created_at',
  updated: 'updated_at',
  size: 'bytes',
  filename: 'original_name',
} as const;

export function descriptionsEnabled(config: {
  metadata: { mode: string };
  gemini: { apiKey: string };
}): boolean {
  return config.metadata.mode === 'stored' && config.gemini.apiKey.length > 0;
}

export function parseListQuery(
  input: ListQueryInput,
  config: { metadata: { mode: string }; gemini: { apiKey: string } },
): ParsedListQuery {
  const types = unique(
    [...listValues(input.type), ...listValues(input.types)].map((value) =>
      value.toLowerCase(),
    ),
  );
  for (const type of types) {
    if (!ASSET_TYPES.includes(type as AssetType)) {
      throw queryError(
        `type must be one of ${ASSET_TYPES.join(', ')}. "document" means PDF, text, CSV, and Office files (Word, Excel, PowerPoint).`,
      );
    }
  }
  const category = input.tagCategory?.toLowerCase();
  const tags = parseTags(
    [...listValues(input.tag), ...listValues(input.tags)],
    category,
  );
  const tagsAll = parseTags(listValues(input.tagsAll), category);
  const words = (input.q ?? '')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const descriptionFilter =
    tags.length > 0 ||
    tagsAll.length > 0 ||
    Boolean(input.tagCategory) ||
    words.length > 0 ||
    Boolean(input.descriptionStatus) ||
    input.hasDescription !== undefined;
  if (descriptionFilter && !descriptionsEnabled(config)) {
    if (config.metadata.mode !== 'stored') {
      throw fail('DESCRIPTION_REQUIRES_DATABASE', {
        message:
          'Tag and description filters need a database. Set FILEVORA_DATABASE_URL to postgres://, mysql://, or sqlite://./filevora.sqlite and run npx filevora migrate.',
      });
    }
    throw fail('DESCRIPTION_NOT_CONFIGURED', {
      message:
        'Tag and description filters need a Gemini API key. Set FILEVORA_GEMINI_API_KEY. Descriptions stay off until that variable is set.',
    });
  }
  if (category && tags.length === 0 && tagsAll.length === 0) {
    throw queryError(
      `tagCategory needs tag, tags, or tagsAll. Categories: ${TAG_CATEGORIES.join(', ')}.`,
    );
  }
  if (
    category &&
    !TAG_CATEGORIES.includes(category as (typeof TAG_CATEGORIES)[number])
  ) {
    throw queryError(
      `tagCategory must be one of ${TAG_CATEGORIES.join(', ')}. A tag can also be category:value, for example kind:speech or language:italian.`,
    );
  }
  const createdFrom = bound(
    input.createdFrom ?? input.createdAfter,
    'createdFrom',
    'start',
  );
  const createdTo = bound(input.createdTo, 'createdTo', 'end');
  const updatedFrom = bound(input.updatedFrom, 'updatedFrom', 'start');
  const updatedTo = bound(input.updatedTo, 'updatedTo', 'end');
  if (createdFrom && createdTo && createdFrom > createdTo) {
    throw queryError('createdFrom must be before or equal to createdTo.');
  }
  if (updatedFrom && updatedTo && updatedFrom > updatedTo) {
    throw queryError('updatedFrom must be before or equal to updatedTo.');
  }
  const sizeMin = integerBound(input.sizeMin, 'sizeMin');
  const sizeMax = integerBound(input.sizeMax, 'sizeMax');
  if (sizeMin !== undefined && sizeMax !== undefined && sizeMin > sizeMax) {
    throw queryError('sizeMin must be less than or equal to sizeMax.');
  }
  const durationMin = integerBound(input.durationMin, 'durationMin');
  const durationMax = integerBound(input.durationMax, 'durationMax');
  if (
    durationMin !== undefined &&
    durationMax !== undefined &&
    durationMin > durationMax
  ) {
    throw queryError('durationMin must be less than or equal to durationMax.');
  }
  const widthMin = integerBound(input.widthMin, 'widthMin');
  const heightMin = integerBound(input.heightMin, 'heightMin');
  const processingStatus = input.processingStatus ?? input.status;
  let processing: string | undefined;
  if (processingStatus) {
    processing =
      processingStatus === 'completed'
        ? 'ready'
        : processingStatus.toLowerCase();
    if (
      !PROCESSING_STATUSES.includes(
        processing as (typeof PROCESSING_STATUSES)[number],
      )
    ) {
      throw queryError(
        `status must be one of ${PROCESSING_STATUSES.join(', ')}. "completed" means ready.`,
      );
    }
  }
  let descriptionStatus: ParsedListQuery['descriptionStatus'];
  if (input.descriptionStatus) {
    const value = input.descriptionStatus.toLowerCase();
    if (
      !DESCRIPTION_STATUSES.includes(
        value as (typeof DESCRIPTION_STATUSES)[number],
      )
    ) {
      throw queryError(
        `descriptionStatus must be one of ${DESCRIPTION_STATUSES.join(', ')}.`,
      );
    }
    descriptionStatus = value as ParsedListQuery['descriptionStatus'];
  }
  let visibility: 'public' | 'private' | undefined;
  if (input.visibility) {
    if (input.visibility !== 'public' && input.visibility !== 'private') {
      throw queryError('visibility must be public or private.');
    }
    visibility = input.visibility;
  }
  const sort = (input.sort ?? 'created').toLowerCase();
  if (!SORT_FIELDS.includes(sort as SortField)) {
    throw queryError(`sort must be one of ${SORT_FIELDS.join(', ')}.`);
  }
  const order = (input.order ?? 'desc').toLowerCase();
  if (!SORT_ORDERS.includes(order as SortOrder)) {
    throw queryError('order must be asc or desc.');
  }
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw queryError('limit must be an integer from 1 to 100.');
  }
  return {
    limit,
    cursor: input.cursor ? decodeCursor(input.cursor) : null,
    types: types as AssetType[],
    ...(input.kind ? { kind: input.kind } : {}),
    ...(createdFrom ? { createdFrom } : {}),
    ...(createdTo ? { createdTo } : {}),
    ...(updatedFrom ? { updatedFrom } : {}),
    ...(updatedTo ? { updatedTo } : {}),
    tags,
    tagsAll,
    ...(category ? { tagCategory: category } : {}),
    words,
    ...(input.mime ? { mime: input.mime.toLowerCase() } : {}),
    ...(input.filename ? { filename: input.filename } : {}),
    ...(sizeMin !== undefined ? { sizeMin } : {}),
    ...(sizeMax !== undefined ? { sizeMax } : {}),
    ...(durationMin !== undefined ? { durationMin } : {}),
    ...(durationMax !== undefined ? { durationMax } : {}),
    ...(widthMin !== undefined ? { widthMin } : {}),
    ...(heightMin !== undefined ? { heightMin } : {}),
    ...(processing ? { processingStatus: processing } : {}),
    ...(descriptionStatus ? { descriptionStatus } : {}),
    ...(visibility ? { visibility } : {}),
    ...(input.preset ? { preset: input.preset } : {}),
    ...(input.hasDescription !== undefined
      ? { hasDescription: input.hasDescription }
      : {}),
    sort: sort as SortField,
    order: order as SortOrder,
  };
}

export function parseListSearchParams(params: URLSearchParams): ListQueryInput {
  const bool = (name: string): boolean | undefined => {
    const value = params.get(name);
    if (value === null || value === '') return undefined;
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw queryError(`${name} must be true or false.`);
  };
  const num = (name: string): number | undefined => {
    const value = params.get(name);
    if (value === null || value === '') return undefined;
    if (!/^\d+$/.test(value))
      throw queryError(`${name} must be a non-negative integer.`);
    return Number(value);
  };
  const repeated = (name: string): string[] =>
    params
      .getAll(name)
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  return {
    ...(params.get('limit') ? { limit: num('limit') } : {}),
    ...(params.get('cursor')
      ? { cursor: params.get('cursor') ?? undefined }
      : {}),
    ...(params.get('kind') ? { kind: params.get('kind') ?? undefined } : {}),
    ...(repeated('type').length > 0 || repeated('types').length > 0
      ? { types: [...repeated('type'), ...repeated('types')] }
      : {}),
    ...(params.get('createdFrom')
      ? { createdFrom: params.get('createdFrom') ?? undefined }
      : {}),
    ...(params.get('createdTo')
      ? { createdTo: params.get('createdTo') ?? undefined }
      : {}),
    ...(params.get('createdAfter')
      ? { createdAfter: params.get('createdAfter') ?? undefined }
      : {}),
    ...(params.get('updatedFrom')
      ? { updatedFrom: params.get('updatedFrom') ?? undefined }
      : {}),
    ...(params.get('updatedTo')
      ? { updatedTo: params.get('updatedTo') ?? undefined }
      : {}),
    ...(repeated('tag').length > 0 ? { tag: repeated('tag') } : {}),
    ...(repeated('tags').length > 0 ? { tags: repeated('tags') } : {}),
    ...(repeated('tagsAll').length > 0 ? { tagsAll: repeated('tagsAll') } : {}),
    ...(params.get('tagCategory')
      ? { tagCategory: params.get('tagCategory') ?? undefined }
      : {}),
    ...(params.get('q') ? { q: params.get('q') ?? undefined } : {}),
    ...(params.get('mime') ? { mime: params.get('mime') ?? undefined } : {}),
    ...(params.get('filename')
      ? { filename: params.get('filename') ?? undefined }
      : {}),
    ...(params.get('sizeMin') ? { sizeMin: num('sizeMin') } : {}),
    ...(params.get('sizeMax') ? { sizeMax: num('sizeMax') } : {}),
    ...(params.get('durationMin') ? { durationMin: num('durationMin') } : {}),
    ...(params.get('durationMax') ? { durationMax: num('durationMax') } : {}),
    ...(params.get('widthMin') ? { widthMin: num('widthMin') } : {}),
    ...(params.get('heightMin') ? { heightMin: num('heightMin') } : {}),
    ...(params.get('status')
      ? { status: params.get('status') ?? undefined }
      : {}),
    ...(params.get('processingStatus')
      ? { processingStatus: params.get('processingStatus') ?? undefined }
      : {}),
    ...(params.get('descriptionStatus')
      ? { descriptionStatus: params.get('descriptionStatus') ?? undefined }
      : {}),
    ...(params.get('visibility')
      ? { visibility: params.get('visibility') ?? undefined }
      : {}),
    ...(params.get('preset')
      ? { preset: params.get('preset') ?? undefined }
      : {}),
    ...(bool('hasDescription') !== undefined
      ? { hasDescription: bool('hasDescription') }
      : {}),
    ...(params.get('sort') ? { sort: params.get('sort') ?? undefined } : {}),
    ...(params.get('order') ? { order: params.get('order') ?? undefined } : {}),
  };
}

export function storedListSql(
  query: ParsedListQuery,
  tenantId: string,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [tenantId, 'verified'];
  const where = ['tenant_id = ?', 'deleted_at IS NULL', 'upload_state = ?'];
  if (query.kind) pushKind(where, params, query.kind);
  if (query.types.length > 0) {
    where.push(
      `(${query.types.map((type) => typeSql(type, params)).join(' OR ')})`,
    );
  }
  pushRange(where, params, 'created_at', query.createdFrom, query.createdTo);
  pushRange(where, params, 'updated_at', query.updatedFrom, query.updatedTo);
  const anyTags = tagSql(query.tags, params, 'any');
  if (anyTags) where.push(anyTags);
  const allTags = tagSql(query.tagsAll, params, 'all');
  if (allTags) where.push(allTags);
  for (const word of query.words) {
    const pattern = likeContains(word);
    where.push(
      `(LOWER(COALESCE(description_short, '')) LIKE ? ESCAPE '!' OR LOWER(COALESCE(description_long, '')) LIKE ? ESCAPE '!')`,
    );
    params.push(pattern, pattern);
  }
  if (query.mime) {
    if (query.mime.endsWith('/')) {
      where.push('(detected_mime LIKE ? OR declared_mime LIKE ?)');
      params.push(`${query.mime}%`, `${query.mime}%`);
    } else {
      where.push('(detected_mime = ? OR declared_mime = ?)');
      params.push(query.mime, query.mime);
    }
  }
  if (query.filename) {
    where.push(`LOWER(original_name) LIKE ? ESCAPE '!'`);
    params.push(likeContains(query.filename.toLowerCase()));
  }
  if (query.sizeMin !== undefined) {
    where.push('bytes >= ?');
    params.push(query.sizeMin);
  }
  if (query.sizeMax !== undefined) {
    where.push('bytes <= ?');
    params.push(query.sizeMax);
  }
  if (query.durationMin !== undefined) {
    where.push(
      `id IN (SELECT file_id FROM variants WHERE status = 'ready' AND duration_ms >= ?)`,
    );
    params.push(query.durationMin);
  }
  if (query.durationMax !== undefined) {
    where.push(
      `id IN (SELECT file_id FROM variants WHERE status = 'ready' AND duration_ms <= ?)`,
    );
    params.push(query.durationMax);
  }
  if (query.widthMin !== undefined) {
    where.push(
      `id IN (SELECT file_id FROM variants WHERE status = 'ready' AND width >= ?)`,
    );
    params.push(query.widthMin);
  }
  if (query.heightMin !== undefined) {
    where.push(
      `id IN (SELECT file_id FROM variants WHERE status = 'ready' AND height >= ?)`,
    );
    params.push(query.heightMin);
  }
  if (query.processingStatus) {
    where.push('processing_state = ?');
    params.push(query.processingStatus);
  }
  if (query.descriptionStatus) {
    where.push('description_status = ?');
    params.push(query.descriptionStatus);
  }
  if (query.visibility) {
    where.push('visibility = ?');
    params.push(query.visibility);
  }
  if (query.preset) {
    where.push('preset = ?');
    params.push(query.preset);
  }
  if (query.hasDescription === true) {
    where.push(
      "description_status = 'done' AND description_long IS NOT NULL AND description_long != ''",
    );
  }
  if (query.hasDescription === false) {
    where.push(
      "(description_status IS NULL OR description_status != 'done' OR description_long IS NULL OR description_long = '')",
    );
  }
  const column = SORT_COLUMN[query.sort];
  if (query.cursor) {
    const op = query.order === 'desc' ? '<' : '>';
    const cursorValue =
      query.sort === 'size' ? Number(query.cursor.value) : query.cursor.value;
    where.push(`(${column} ${op} ? OR (${column} = ? AND id ${op} ?))`);
    params.push(cursorValue, cursorValue, query.cursor.id);
  }
  params.push(query.limit + 1);
  return {
    sql: `SELECT * FROM files WHERE ${where.join(' AND ')} ORDER BY ${column} ${query.order.toUpperCase()}, id ${query.order.toUpperCase()} LIMIT ?`,
    params,
  };
}

export interface ListRow {
  id: string;
  created_at: string;
  updated_at: string;
  bytes: number;
  original_name: string;
  detected_mime: string | null;
  declared_mime: string;
  processing_state: string;
  description_status?: string | null;
  description_long?: string | null;
  description_short?: string | null;
  visibility: string;
  preset: string | null;
}

export interface ListVariant {
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  status?: string | null;
}

export function rowMatches(
  row: ListRow,
  variants: ListVariant[],
  query: ParsedListQuery,
): boolean {
  const mime = (row.detected_mime || row.declared_mime).toLowerCase();
  const declared = row.declared_mime.toLowerCase();
  if (query.kind && !kindMatches(mime, declared, query.kind)) return false;
  if (
    query.types.length > 0 &&
    !query.types.some((type) => typeMatches(mime, declared, type))
  ) {
    return false;
  }
  if (query.createdFrom && row.created_at < query.createdFrom) return false;
  if (query.createdTo && row.created_at > query.createdTo) return false;
  if (query.updatedFrom && row.updated_at < query.updatedFrom) return false;
  if (query.updatedTo && row.updated_at > query.updatedTo) return false;
  if (query.mime) {
    const prefix = query.mime.endsWith('/');
    const hit = [mime, declared].some((value) =>
      prefix ? value.startsWith(query.mime ?? '') : value === query.mime,
    );
    if (!hit) return false;
  }
  if (
    query.filename &&
    !row.original_name.toLowerCase().includes(query.filename.toLowerCase())
  ) {
    return false;
  }
  if (query.sizeMin !== undefined && row.bytes < query.sizeMin) return false;
  if (query.sizeMax !== undefined && row.bytes > query.sizeMax) return false;
  if (
    query.processingStatus &&
    row.processing_state !== query.processingStatus
  ) {
    return false;
  }
  if (query.visibility && row.visibility !== query.visibility) return false;
  if (query.preset && row.preset !== query.preset) return false;
  const ready = variants.filter((variant) => variant.status === 'ready');
  if (
    query.durationMin !== undefined &&
    !ready.some((variant) => (variant.duration_ms ?? -1) >= query.durationMin!)
  ) {
    return false;
  }
  if (
    query.durationMax !== undefined &&
    !ready.some(
      (variant) =>
        variant.duration_ms != null &&
        variant.duration_ms <= query.durationMax!,
    )
  ) {
    return false;
  }
  if (
    query.widthMin !== undefined &&
    !ready.some((variant) => (variant.width ?? -1) >= query.widthMin!)
  ) {
    return false;
  }
  if (
    query.heightMin !== undefined &&
    !ready.some((variant) => (variant.height ?? -1) >= query.heightMin!)
  ) {
    return false;
  }
  return true;
}

export function sortRows<T extends ListRow>(
  rows: T[],
  query: ParsedListQuery,
): T[] {
  const direction = query.order === 'desc' ? -1 : 1;
  return [...rows].sort((left, right) => {
    const cmp = compareSort(left, right, query.sort);
    if (cmp !== 0) return cmp * direction;
    return left.id < right.id ? -direction : left.id > right.id ? direction : 0;
  });
}

export function encodeListCursor(value: string, id: string): string {
  return Buffer.from(`${value}\n${id}`).toString('base64url');
}

export function cursorValue(row: ListRow, sort: SortField): string {
  if (sort === 'size') return String(row.bytes);
  if (sort === 'updated') return row.updated_at;
  if (sort === 'filename') return row.original_name;
  return row.created_at;
}

export function isAfterCursor(row: ListRow, query: ParsedListQuery): boolean {
  if (!query.cursor) return true;
  const cmp = compareSort(row, cursorRow(query), query.sort);
  if (query.order === 'desc') {
    if (cmp < 0) return true;
    return cmp === 0 && row.id < query.cursor.id;
  }
  if (cmp > 0) return true;
  return cmp === 0 && row.id > query.cursor.id;
}

function cursorRow(query: ParsedListQuery): ListRow {
  const value = query.cursor?.value ?? '';
  return {
    id: query.cursor?.id ?? '',
    created_at: query.sort === 'created' ? value : '',
    updated_at: query.sort === 'updated' ? value : '',
    bytes: query.sort === 'size' ? Number(value) : 0,
    original_name: query.sort === 'filename' ? value : '',
    detected_mime: null,
    declared_mime: '',
    processing_state: '',
    visibility: '',
    preset: null,
  };
}

function compareSort(left: ListRow, right: ListRow, sort: SortField): number {
  if (sort === 'size') return left.bytes - right.bytes;
  const column =
    sort === 'updated'
      ? 'updated_at'
      : sort === 'filename'
        ? 'original_name'
        : 'created_at';
  const a = String(left[column] ?? '');
  const b = String(right[column] ?? '');
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function queryError(message: string): never {
  throw fail('LIST_QUERY_INVALID', { message });
}

function listValues(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : value.split(',');
  return list.map((item) => item.trim()).filter((item) => item.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parseTags(values: string[], fallbackCategory?: string): TagFilter[] {
  const seen = new Set<string>();
  const tags: TagFilter[] = [];
  for (const value of values) {
    const scoped = /^([a-z]+):(.+)$/i.exec(value.trim());
    let category = fallbackCategory;
    let tag = value.trim().toLowerCase();
    if (
      scoped?.[1] &&
      scoped[2] &&
      TAG_CATEGORIES.includes(
        scoped[1].toLowerCase() as (typeof TAG_CATEGORIES)[number],
      )
    ) {
      category = scoped[1].toLowerCase();
      tag = scoped[2].trim().toLowerCase();
    }
    if (!tag) continue;
    const key = `${category ?? ''}:${tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(category ? { tag, category } : { tag });
  }
  return tags;
}

function tagSql(
  filters: TagFilter[],
  params: unknown[],
  mode: 'any' | 'all',
): string | null {
  if (filters.length === 0) return null;
  const parts = filters.map((filter) => {
    params.push(filter.tag);
    if (!filter.category) return 'tag = ?';
    params.push(filter.category);
    return '(tag = ? AND category = ?)';
  });
  if (mode === 'any') {
    return `id IN (SELECT asset_id FROM filevora_asset_tags WHERE ${parts.join(' OR ')})`;
  }
  return parts
    .map(
      (part) =>
        `id IN (SELECT asset_id FROM filevora_asset_tags WHERE ${part})`,
    )
    .join(' AND ');
}

function bound(
  value: string | undefined,
  name: string,
  edge: 'start' | 'end',
): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return edge === 'start'
      ? `${value}T00:00:00.000Z`
      : `${value}T23:59:59.999Z`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw queryError(
      `${name} must be an ISO 8601 date (YYYY-MM-DD) or datetime.`,
    );
  }
  return parsed.toISOString();
}

function integerBound(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw queryError(`${name} must be a non-negative integer.`);
  }
  return value;
}

function decodeCursor(cursor: string): { value: string; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const splitAt = raw.indexOf('\n');
  if (splitAt <= 0)
    throw queryError('cursor is not a pagination cursor from this list.');
  return { value: raw.slice(0, splitAt), id: raw.slice(splitAt + 1) };
}

function likeContains(value: string): string {
  return `%${value.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_')}%`;
}

function pushRange(
  where: string[],
  params: unknown[],
  column: string,
  from: string | undefined,
  to: string | undefined,
): void {
  if (from) {
    where.push(`${column} >= ?`);
    params.push(from);
  }
  if (to) {
    where.push(`${column} <= ?`);
    params.push(to);
  }
}

function pushKind(where: string[], params: unknown[], kind: string): void {
  where.push('(detected_mime LIKE ? OR declared_mime LIKE ?)');
  const prefix =
    kind === 'pdf'
      ? 'application/pdf%'
      : `${kind === 'tabular' ? 'text/csv' : kind}/%`;
  params.push(prefix, prefix);
}

function typeSql(type: AssetType, params: unknown[]): string {
  if (type === 'document') {
    params.push(
      'application/pdf',
      'application/pdf',
      'text/%',
      'text/%',
      'application/msword%',
      'application/msword%',
      'application/vnd.ms-%',
      'application/vnd.ms-%',
      'application/vnd.openxmlformats-officedocument.%',
      'application/vnd.openxmlformats-officedocument.%',
    );
    return `(detected_mime = ? OR declared_mime = ? OR detected_mime LIKE ? OR declared_mime LIKE ? OR detected_mime LIKE ? OR declared_mime LIKE ? OR detected_mime LIKE ? OR declared_mime LIKE ? OR detected_mime LIKE ? OR declared_mime LIKE ?)`;
  }
  params.push(`${type}/%`, `${type}/%`);
  return '(detected_mime LIKE ? OR declared_mime LIKE ?)';
}

function kindMatches(mime: string, declared: string, kind: string): boolean {
  if (kind === 'pdf')
    return mime === 'application/pdf' || declared === 'application/pdf';
  const prefix = kind === 'tabular' ? 'text/csv' : `${kind}/`;
  return mime.startsWith(prefix) || declared.startsWith(prefix);
}

function typeMatches(mime: string, declared: string, type: AssetType): boolean {
  if (type === 'document') {
    return [mime, declared].some(
      (value) =>
        value === 'application/pdf' ||
        value.startsWith('text/') ||
        value.startsWith('application/msword') ||
        value.startsWith('application/vnd.ms-') ||
        value.startsWith('application/vnd.openxmlformats-officedocument.'),
    );
  }
  return mime.startsWith(`${type}/`) || declared.startsWith(`${type}/`);
}
