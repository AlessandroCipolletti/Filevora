# REMOTE_URL_BLOCKED

The remote address is blocked.

Category: `upload`. HTTP 400. Retryable: false.

Loopback, private, link-local, multicast, and cloud metadata addresses are blocked. DNS answers are checked, and the connection uses a checked address. FILEVORA_REMOTE_ALLOW_PRIVATE=true allows private addresses on the URL you pass, not on a redirect.

- public_host: Use a public http or https URL. For a local server, set FILEVORA_REMOTE_ALLOW_PRIVATE=true. (`FILEVORA_REMOTE_ALLOW_PRIVATE=true`)
