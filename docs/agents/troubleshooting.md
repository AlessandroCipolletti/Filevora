# Troubleshooting

| Code                         | Cause                                                                            | Remedy                                                                                                           | Check                                 |
| ---------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `FEATURE_NOT_AVAILABLE`      | Managed provider, cloud processing, or a milestone that is not implemented       | Stay on filesystem or your own infrastructure. Do not create a Filevora account; it will not enable the feature. | `npx filevora config validate --json` |
| `INVALID_CONFIG`             | Options or `FILES_*` values failed validation                                    | Read `error.context.issues`                                                                                      | `npx filevora config validate --json` |
| `UNSAFE_PRODUCTION_CONFIG`   | Production local disk without `singleHostAcknowledged`, or a temp directory root | Use persistent paths and set `FILES_SINGLE_HOST_ACK=true` only when one host owns that SQLite file               | `npx filevora config validate --json` |
| `WORKER_UNSUPPORTED_RUNTIME` | `worker` plus `on-demand` spawn on serverless or edge                            | Use `processing.mode: "distributed"` and a separate worker process, or run a long-lived Node server              | `npx filevora config validate --json` |

`doctor` is not implemented. The table grows when new failures are tested.
