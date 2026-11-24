# DELIVERY_REVOKED

The delivery URL was revoked.

Category: `auth`. HTTP 403. Retryable: false.

Each asset has a `url_salt`. `POST /files/:assetId/revoke-urls` replaces it. Tokens signed with the previous salt no longer match.

- sign_again: Issue a new URL after rotating the salt.
