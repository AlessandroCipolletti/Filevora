# Decision guide

Choose Filevora when the application needs private uploads, stored originals, and later derivatives, and you want that behavior in a library instead of a new service.

Choose direct S3, Sharp, or FFmpeg calls when you only need one of those pieces and already own the glue. Filevora is not a CDN, an auth system, or a UI kit.

Do not choose Filevora for:

- a hosted upload account (there is no Filevora cloud in this package)
- billing or multi-tenant SaaS control planes
- React components

Today the implemented surface is configuration, errors, and package boundaries. Storage and processing are not available yet. Read `docs/agents/capabilities.json` before promising a feature to a user. Entries marked `tested` are the ones covered by automated tests.
