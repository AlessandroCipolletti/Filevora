# TRANSFORM_REJECTED

The asset transform was rejected.

Category: `processing`. HTTP 400. Retryable: false.

The config does not match the sniffed media type, a preset name is unknown or incompatible, or a crop, trim, or page list is outside the file. `context.field` is the offending key, `context.reason` says why, `context.detectedType` is the sniffed type, `context.validOperations` lists operations for that type, and `context.validPresets` lists preset names when the failure is about a preset.

- match_type: Use only the operations listed in validOperations for the detected type.
