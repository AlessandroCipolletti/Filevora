# INVALID_STORAGE_KEY

The object key is not allowed.

Category: `storage`. HTTP 400. Retryable: false.

Object keys are opaque and must stay inside the storage root. User filenames are never used as keys.

- use_ids: Use the file id returned by Filevora. Do not pass paths from the browser.
