# TRANSFORM_REJECTED

The asset transform was rejected.

Category: `processing`. HTTP 400. Retryable: false.

The config does not match the sniffed media type, or a crop, trim, or page list is outside the file. `context.field` is the offending key, `context.reason` says why, `context.detectedType` is the sniffed type, and `context.validOperations` lists what that type accepts.

- match_type: Use only the operations listed in validOperations for the detected type.
