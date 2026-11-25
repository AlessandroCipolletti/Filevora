# List filters for agents

Use `GET /files` for exact filters. For meaning-based search use `POST /files/search` (see [search.md](search.md)). `GET /files` has no vector search. `q` is a case-insensitive `LIKE` over `description_short` and `description_long`. Every word must match. `%` and `_` in `q` or `filename` are literal.

Default sort is `created` descending, then `id` descending. Keep `sort`, `order`, and the filters when you pass `nextCursor` back as `cursor`. `limit` defaults to 20 and cannot exceed 100.

`type` accepts `image`, `video`, `document`, `audio`. One or many, repeated or comma-separated. `document` means PDF, text, CSV, and Office files.

Dates are ISO 8601. `createdFrom=2026-10-01` is the start of that UTC day. `createdTo=2026-10-31` includes that whole day. `createdFrom` after `createdTo` is `LIST_QUERY_INVALID`.

Tags are matched case-insensitively on `filevora_asset_tags`. `tags` is any-of. `tagsAll` is all-of. Scope a tag with `emotion:joyful`, `kind:speech`, or `language:italian`, or set `tagCategory` for every plain tag. Categories: `subject`, `action`, `style`, `purpose`, `emotion`, `kind`, `language`.

Other filters: `mime` (exact, or a prefix ending in `/`), `filename`, `sizeMin`, `sizeMax`, `durationMin`, `durationMax` (milliseconds), `widthMin`, `heightMin`, `status`, `visibility` (`public` or `private`), `preset`, `updatedFrom`, `updatedTo`. `sort` is `created`, `updated`, `size`, or `filename`. `order` is `asc` or `desc`.

`tag`, `tags`, `tagsAll`, `tagCategory`, `q`, `descriptionStatus`, and `hasDescription` require stored mode and `FILEVORA_GEMINI_API_KEY`. Otherwise the response is `DESCRIPTION_REQUIRES_DATABASE` (lite) or `DESCRIPTION_NOT_CONFIGURED` (no key), with the fix hint. Do not retry the same query unchanged.

Type, date, size, mime, filename, dimensions, duration, visibility, preset, and processing status work in lite and stored mode. `GET /assets` does not. Lite reads cards for one tenant. It does not scan every object in the bucket.

## Examples

Find joyful videos from last month:

`GET /files?type=video&tags=emotion:joyful&createdFrom=2026-10-01&createdTo=2026-10-31`

Find speech audio in Italian:

`GET /files?type=audio&tagsAll=kind:speech&tagsAll=language:italian`

SDK: `client.list({ type: 'video', tags: 'emotion:joyful', createdFrom: '2026-10-01', createdTo: '2026-10-31' })`.

MCP tool `list_files` validates this query for the current env and returns the `GET /files` URL. It does not query the database.
