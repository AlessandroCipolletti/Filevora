# REMOTE_URL_CREDENTIALS

The remote URL must not include credentials.

Category: `upload`. HTTP 400. Retryable: false.

A username or password in the URL is rejected so it is not sent or logged.

- strip_userinfo: Remove the username and password from the URL.
