# QUOTA_EXCEEDED

The tenant storage quota would be exceeded.

Category: `quota`. HTTP 429. Retryable: false.

The reserved and stored bytes for this tenant are above FILES_TENANT_QUOTA_BYTES or the policy quota.

- raise_quota: Raise the tenant quota or delete unneeded files.
