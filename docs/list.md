# List and filter assets

`GET /files` is the only list. Its `q` filter uses `LIKE` on the description columns and builds no full-text index. For meaning-based search use `POST /files/search`, described in [semantic search](search.md).

The default page is 20 assets, newest first (`sort=created&order=desc`), with `id` as the tiebreaker. `limit` is 1 to 100. `cursor` is opaque. Send it back as `cursor` to read the next page. The same sort and filters must stay on that request.

## Filters

Repeat a parameter or send a comma list.

| Parameter | Meaning |
| --- | --- |
| `type` or `types` | `image`, `video`, `document`, `audio`. `document` is PDF, `text/*` (including CSV), and Office (Word, Excel, PowerPoint). |
| `createdFrom`, `createdTo` | Inclusive creation time. Either end may be omitted. |
| `updatedFrom`, `updatedTo` | Inclusive `updated_at` range. |
| `createdAfter` | Same as `createdFrom`. Kept for older clients. |
| `kind` | Older prefix filter: `image`, `video`, `audio`, `pdf`, `tabular`. |
| `tags` | Any of these tags. |
| `tagsAll` | Every tag must be present. |
| `tagCategory` | Limit `tag`, `tags`, and `tagsAll` to one category: `subject`, `action`, `style`, `purpose`, `emotion`, `kind`, `language`. |
| `q` | Words that must all appear in `description_short` or `description_long`. Matching is case-insensitive. `%` and `_` are matched as characters. |
| `mime` | Exact type, or a prefix when the value ends in `/` (`audio/`). |
| `filename` | Case-insensitive substring of the original filename. |
| `sizeMin`, `sizeMax` | Byte size, inclusive. |
| `durationMin`, `durationMax` | Milliseconds on a ready video or audio version. |
| `widthMin`, `heightMin` | Pixels on a ready version. |
| `status` | Processing state: `none`, `queued`, `processing`, `ready`, `failed`, `partially_ready`, `retrying`, `quarantined`. `completed` means `ready`. |
| `descriptionStatus` | `pending`, `done`, or `failed`. |
| `hasDescription` | `true` means status `done` and a non-empty long description. |
| `visibility` | `public` or `private`. |
| `preset` | Exact preset name. |
| `sort`, `order` | `created`, `updated`, `size`, `filename` and `asc` or `desc`. |

A tag may name its category: `kind:speech`, `language:italian`, `emotion:joyful`. That wins over `tagCategory`.

## Description filters

`tag`, `tags`, `tagsAll`, `tagCategory`, `q`, `descriptionStatus` (`pending`, `done`, `failed`), and `hasDescription` are read only when descriptions are enabled: stored mode and `FILEVORA_GEMINI_API_KEY`.

Lite mode returns `DESCRIPTION_REQUIRES_DATABASE`. Stored mode without a key returns `DESCRIPTION_NOT_CONFIGURED`. The filter is not ignored.

Every other filter works in lite and stored mode. Lite mode reads the asset cards for that tenant and filters them in process. `GET /assets` stays stored-only.

## Examples

Joyful videos created in October 2026:

```http
GET /files?type=video&tags=joyful&tagCategory=emotion&createdFrom=2026-10-01&createdTo=2026-10-31
```

Speech audio in Italian:

```http
GET /files?type=audio&tagsAll=kind:speech&tagsAll=language:italian
```

```ts
const page = await client.list({
  type: 'audio',
  tagsAll: ['kind:speech', 'language:italian'],
  sort: 'created',
  order: 'desc',
});
```

The browser client method is `createUploadClient().list`. The same query string works through the Next, Express, Fastify, and Hono handlers. `list_files` on `filevora mcp` checks the query and does not open the database.
