# RETENTION_POLICY_UNSAFE

The retention policy could delete data without an explicit safe rule.

Category: `config`. HTTP 400. Retryable: false.

Inactivity deletion needs an evidence source, and age-based deletion must be explicitly enabled. Dry-run before a real sweep.

- dry_run: Run a retention dry-run and review filesEligible before deleting.
