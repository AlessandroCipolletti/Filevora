# ADR 0016: Public SDK only

## Status

Accepted

## Problem

Filevora may later sell hosted storage, processing, and delivery. That work must not land in this repository.

## Constraints

Anyone can install the package and run files on their own machine or infrastructure. No Filevora account.

## Options

1. Reserve provider interfaces and `FILES_CLOUD_*` keys. Reject `managed` and `hybrid` with `FEATURE_NOT_AVAILABLE`. Build no billing, accounts, API-key issuance, or control plane.
2. Add a stub cloud client that accepts an API key and returns sample data.

## Decision

Option 1. Confirmed by the maintainer: the paid backend is a separate private project. A stub that pretends to upload would be worse than a hard error.

## Rejected alternatives

Sample cloud responses would teach agents to ship a key that does nothing useful, or worse, to trust a fake success.

## Security and reliability

Cloud keys are redacted if present and do not change the embedded or distributed path. There is no network call to a Filevora service.

## Migration

A future package can implement `StorageDriver` and the same server methods. This package's public types stay the contract.

## Tests

M0 rejects managed, hybrid, and cloud processing. The capability manifest marks billing, accounts, hosted control plane, and the managed provider unsupported.
