# DELIVERY_PRIVATE

This asset is not public.

Category: `auth`. HTTP 403. Retryable: false.

`/public/:assetId/:version` serves an asset only when its visibility is `public`. A missing asset card is private, so a file without a card is never published by accident.

- use_signed: Fetch a signed `/content` URL, or set visibility to `public` when that is intended.
