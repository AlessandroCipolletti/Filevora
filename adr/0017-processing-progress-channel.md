# ADR 0017: Processing progress channel

## Status

Accepted

## Problem

A host app needs percent and a remaining-time estimate while a long job runs. ADR 0009 kept polling as the baseline and left a push channel for later.

## Constraints

The host still authenticates the request. The browser must not receive a signing secret. The channel has to work through the existing Web `Request` handler.

## Options

1. Server-sent events read with `fetch`, so the host's `Authorization` header is still sent. Poll the same snapshot if the stream fails.
2. `EventSource` only. It cannot set `Authorization`.
3. WebSocket upgrade. Many hosts that only adapt `Request` to `Response` cannot do it.

## Decision

Option 1. `GET /files/:id/progress` is `text/event-stream` when the client accepts a stream, and one JSON snapshot when `Accept` is `application/json`. Video and audio jobs emit ratio and `etaMs`. Image and other short jobs emit only the terminal snapshot. `waitForProcessing` still polls.

## Rejected alternatives

Native `EventSource` drops bearer tokens. A WebSocket needs an upgrade the HTTP adapter does not provide.

## Security and reliability

The route uses the same `authenticate` and `authorize` callbacks as file reads. Events carry file id, state, percent, and eta. They do not carry storage keys or secrets. The client falls back to polling after a stream error.

## Tests

A video-typed file emits percent and eta, then a terminal event. An image emits one quiet terminal event.
