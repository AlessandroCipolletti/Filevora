# ADR 0018: Upload history storage

## Status

Accepted

## Problem

The host needs in-flight status, everything started since this page load, and signed URLs for finished variants. That list must not become a second credential store.

## Constraints

History is scoped to the page load. Resume across refresh already uses IndexedDB for session ids and completed part numbers. Signed URLs expire.

## Options

1. Keep history in memory on the upload client. Keep resume metadata in the existing resume store. Refetch delivery URLs when history is read.
2. Persist history, including URLs, in IndexedDB.
3. Store history on the server as a new account-like feed.

## Decision

Option 1. `history()` returns the in-memory list for this client instance. `pending()` lists resume-store sessions so a refreshed page can show an interrupted upload before `upload()` continues it. Completed entries store the file id and refetch `POST /files/:id/delivery` so URLs stay short-lived.

## Rejected alternatives

Persisting signed URLs survives longer than the URL. A server-side history feed would duplicate the host's own file list and is out of scope for the public SDK.

## Security and reliability

The resume record stores the session id, part numbers, and optional file bytes under the size cap. It does not store the signing secret. Delivery URLs are requested with the host's headers at read time.

## Tests

Progress events, a second client on the same resume store after a simulated refresh, and history entries that include a signed URL.
