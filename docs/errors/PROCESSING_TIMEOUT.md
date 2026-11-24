# PROCESSING_TIMEOUT

Processing exceeded the job timeout.

Category: `processing`. HTTP 504. Retryable: true.

The job ran longer than FILES_JOB_TIMEOUT_SECONDS or the per-recipe limit.

- raise_timeout: Raise the timeout only for trusted inputs, or reduce output size and duration.
