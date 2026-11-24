# SCHEMA_VALIDATION_FAILED

The tabular file failed schema validation.

Category: `processing`. HTTP 422. Retryable: false.

One or more rows or the header did not match the requested schema. See the row error artifact.

- fix_rows: Correct the source rows or relax the schema. Invalid values are not coerced silently when the policy says collect or fail.
