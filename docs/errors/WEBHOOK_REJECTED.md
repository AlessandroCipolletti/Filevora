# WEBHOOK_REJECTED

The webhook URL was rejected.

Category: `config`. HTTP 400. Retryable: false.

Webhook targets must be HTTPS in production. Loopback and private addresses are rejected so the worker cannot be used as a proxy.

- public_https: Register an HTTPS endpoint that you control.
