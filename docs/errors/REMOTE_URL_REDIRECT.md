# REMOTE_URL_REDIRECT

The remote redirect was rejected.

Category: `upload`. HTTP 400. Retryable: false.

Each redirect is checked with the same rules. A redirect to a private address is rejected even when private addresses are allowed on the original URL. The hop limit is FILEVORA_REMOTE_MAX_REDIRECTS.

- direct_url: Pass the final public URL, or raise FILEVORA_REMOTE_MAX_REDIRECTS.
