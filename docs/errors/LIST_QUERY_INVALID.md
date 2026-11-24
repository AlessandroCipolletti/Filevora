# LIST_QUERY_INVALID

A `GET /files` filter is invalid. The message names the parameter and the values it accepts.

Category: `config`. HTTP 400. Retryable: false.

`type` is `image`, `video`, `document`, or `audio`. `document` means PDF, text, CSV, and Office files (Word, Excel, PowerPoint). `sort` is `created`, `updated`, `size`, or `filename`. `order` is `asc` or `desc`. Dates are ISO 8601 (`YYYY-MM-DD` or a datetime). A date-only `createdTo` or `updatedTo` includes that whole day.

- fix_list_query: Read the parameter named in the error and send one of the listed values.

See [list filters](../list.md).
