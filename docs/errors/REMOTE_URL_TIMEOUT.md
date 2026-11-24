# REMOTE_URL_TIMEOUT

The remote download timed out.

Category: `upload`. HTTP 504. Retryable: true.

The connect timeout is FILEVORA_REMOTE_CONNECT_TIMEOUT_MS. The whole download, including redirects, stops at FILEVORA_REMOTE_TIMEOUT_MS.

- raise_timeout: Raise the timeout or retry when the host is slow. (`FILEVORA_REMOTE_TIMEOUT_MS=120000`)
