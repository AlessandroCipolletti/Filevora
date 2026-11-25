const ERROR_CATEGORIES = [
  'config',
  'auth',
  'upload',
  'storage',
  'processing',
  'quota',
  'internal',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export interface ErrorAction {
  id: string;
  description: string;
  command?: string;
  safeToAutomate: boolean;
}

export interface ErrorResolution {
  explanation: string;
  actions: ErrorAction[];
  documentationPath: string;
  verifyCommand?: string;
}

export interface ErrorSpec {
  httpStatus: number;
  category: ErrorCategory;
  retryable: boolean;
  message: string;
  resolution: ErrorResolution;
}

const doctor = 'npx filevora doctor --json';

function resolution(
  documentationPath: string,
  explanation: string,
  actions: ErrorAction[],
  verifyCommand?: string,
): ErrorResolution {
  return {
    explanation,
    actions,
    documentationPath,
    ...(verifyCommand ? { verifyCommand } : {}),
  };
}

function action(
  id: string,
  description: string,
  command?: string,
): ErrorAction {
  return {
    id,
    description,
    safeToAutomate: false,
    ...(command ? { command } : {}),
  };
}

/**
 * Stable error catalog. Codes in the product spec are included even when the
 * feature that raises them arrives in a later milestone. Do not rename codes.
 */
export const ERROR_CATALOG = {
  UNAUTHORIZED: {
    httpStatus: 401,
    category: 'auth',
    retryable: false,
    message: 'Authentication is required.',
    resolution: resolution(
      'docs/errors/UNAUTHORIZED.md',
      'The host authenticate callback returned no principal.',
      [
        action(
          'authenticate',
          'Sign the user in before calling the file route.',
        ),
      ],
    ),
  },
  FORBIDDEN: {
    httpStatus: 403,
    category: 'auth',
    retryable: false,
    message: 'The principal is not allowed to perform this operation.',
    resolution: resolution(
      'docs/errors/FORBIDDEN.md',
      'The host authorize callback rejected this operation.',
      [
        action(
          'authorize',
          'Update the application authorization rule for this principal and operation.',
        ),
      ],
    ),
  },
  NOT_FOUND: {
    httpStatus: 404,
    category: 'internal',
    retryable: false,
    message: 'The file or session was not found in this tenant.',
    resolution: resolution(
      'docs/errors/NOT_FOUND.md',
      'The id is unknown, belongs to another tenant, or was deleted. Cross-tenant access returns not found so existence is not leaked.',
      [
        action(
          'check_id',
          'Use the file id returned at upload time for this tenant.',
        ),
      ],
    ),
  },
  QUOTA_EXCEEDED: {
    httpStatus: 429,
    category: 'quota',
    retryable: false,
    message: 'The tenant storage quota would be exceeded.',
    resolution: resolution(
      'docs/errors/QUOTA_EXCEEDED.md',
      'The reserved and stored bytes for this tenant are above FILES_TENANT_QUOTA_BYTES or the policy quota.',
      [
        action(
          'raise_quota',
          'Raise the tenant quota or delete unneeded files.',
        ),
      ],
    ),
  },
  FILE_TOO_LARGE: {
    httpStatus: 413,
    category: 'upload',
    retryable: false,
    message: 'The file is larger than the configured maximum.',
    resolution: resolution(
      'docs/errors/FILE_TOO_LARGE.md',
      'The declared or actual size exceeds maxFileBytes.',
      [
        action(
          'raise_limit',
          'Raise FILES_MAX_FILE_BYTES only if the host can store and process that size.',
        ),
      ],
    ),
  },
  UNSUPPORTED_MIME: {
    httpStatus: 415,
    category: 'upload',
    retryable: false,
    message: 'The file type is not allowed.',
    resolution: resolution(
      'docs/errors/UNSUPPORTED_MIME.md',
      'The sniffed type is outside the server allow list. Client extensions are not trusted.',
      [
        action(
          'allow_type',
          'Add the sniffed MIME type to the server allow list if the product should accept it.',
        ),
      ],
    ),
  },
  MIME_MISMATCH: {
    httpStatus: 415,
    category: 'upload',
    retryable: false,
    message: 'The declared file type does not match the sniffed bytes.',
    resolution: resolution(
      'docs/errors/MIME_MISMATCH.md',
      'The upload declared a MIME type that contradicts the byte signature.',
      [
        action(
          'resend',
          'Upload the file with a declared type that matches its contents.',
        ),
      ],
    ),
  },
  UPLOAD_SESSION_EXPIRED: {
    httpStatus: 410,
    category: 'upload',
    retryable: false,
    message: 'The upload session has expired.',
    resolution: resolution(
      'docs/errors/UPLOAD_SESSION_EXPIRED.md',
      'The session TTL elapsed before completion. Parts from that session are not reusable.',
      [
        action(
          'new_session',
          'Create a new upload session and send the remaining bytes under the new id.',
        ),
      ],
    ),
  },
  UPLOAD_PART_MISSING: {
    httpStatus: 409,
    category: 'upload',
    retryable: true,
    message: 'One or more upload parts are missing.',
    resolution: resolution(
      'docs/errors/UPLOAD_PART_MISSING.md',
      'Completion was requested before every part was stored and verified.',
      [
        action(
          'resume',
          'List the session parts and upload only the missing part numbers.',
        ),
      ],
    ),
  },
  UPLOAD_SIZE_MISMATCH: {
    httpStatus: 422,
    category: 'upload',
    retryable: false,
    message: 'The stored object size does not match the authorized size.',
    resolution: resolution(
      'docs/errors/UPLOAD_SIZE_MISMATCH.md',
      'The concatenated parts are a different length than the size authorized at session creation.',
      [
        action(
          'restart',
          'Abort the session and upload the file again with the correct size.',
        ),
      ],
    ),
  },
  CHECKSUM_MISMATCH: {
    httpStatus: 422,
    category: 'upload',
    retryable: false,
    message: 'The stored checksum does not match the expected checksum.',
    resolution: resolution(
      'docs/errors/CHECKSUM_MISMATCH.md',
      'SHA-256 of the assembled object differs from the checksum supplied by the client.',
      [
        action(
          'reupload',
          'Upload the file again. Do not ignore a checksum mismatch.',
        ),
      ],
    ),
  },
  STORAGE_UNAVAILABLE: {
    httpStatus: 503,
    category: 'storage',
    retryable: true,
    message: 'Object storage is unavailable.',
    resolution: resolution(
      'docs/errors/STORAGE_UNAVAILABLE.md',
      'The storage driver could not read or write the object.',
      [
        action(
          'check_storage',
          'Check the filesystem permissions or S3 credentials and endpoint.',
        ),
      ],
      doctor,
    ),
  },
  WORKER_NOT_RUNNING: {
    httpStatus: 503,
    category: 'processing',
    retryable: true,
    message: 'The processing worker is not running.',
    resolution: resolution(
      'docs/errors/WORKER_NOT_RUNNING.md',
      'No live worker heartbeat was found. Embedded mode starts a child on the first job only in a long-running Node process.',
      [
        action(
          'run_worker',
          'Start a worker with npx filevora worker, or enable on-demand spawn in a long-running process.',
          'npx filevora worker',
        ),
      ],
      doctor,
    ),
  },
  WORKER_UNSUPPORTED_RUNTIME: {
    httpStatus: 501,
    category: 'processing',
    retryable: false,
    message: 'This runtime cannot host a persistent Filevora worker.',
    resolution: resolution(
      'docs/errors/WORKER_UNSUPPORTED_RUNTIME.md',
      'Serverless and edge runtimes cannot keep a durable child worker. Use a long-running Node host or distributed workers.',
      [
        action(
          'move_worker',
          'Run the app on a long-running Node server, or set FILES_PROCESSING_MODE=distributed and deploy npx filevora worker separately.',
        ),
      ],
      doctor,
    ),
  },
  FFMPEG_NOT_FOUND: {
    httpStatus: 501,
    category: 'processing',
    retryable: false,
    message: 'Video processing requires an FFmpeg executable.',
    resolution: resolution(
      'docs/errors/FFMPEG_NOT_FOUND.md',
      'The configured FFmpeg or ffprobe path is not an executable. Filevora does not download binaries.',
      [
        action(
          'install_ffmpeg',
          'Install FFmpeg and ffprobe for the operating system.',
        ),
        action(
          'set_path',
          'Set FILES_FFMPEG_PATH and FILES_FFPROBE_PATH to the executables.',
        ),
      ],
      doctor,
    ),
  },
  FFMPEG_FAILED: {
    httpStatus: 422,
    category: 'processing',
    retryable: false,
    message: 'FFmpeg failed while processing media.',
    resolution: resolution(
      'docs/errors/FFMPEG_FAILED.md',
      'The spawned FFmpeg process exited with an error. Arguments come from the validated recipe, not from the user.',
      [
        action(
          'inspect_media',
          'Probe the original with ffprobe. Reject corrupt or unsupported codecs.',
        ),
      ],
      doctor,
    ),
  },
  PROCESSING_TIMEOUT: {
    httpStatus: 504,
    category: 'processing',
    retryable: true,
    message: 'Processing exceeded the job timeout.',
    resolution: resolution(
      'docs/errors/PROCESSING_TIMEOUT.md',
      'The job ran longer than FILES_JOB_TIMEOUT_SECONDS or the per-recipe limit.',
      [
        action(
          'raise_timeout',
          'Raise the timeout only for trusted inputs, or reduce output size and duration.',
        ),
      ],
    ),
  },
  PDF_ENCRYPTED: {
    httpStatus: 422,
    category: 'processing',
    retryable: false,
    message: 'The PDF is encrypted and cannot be read.',
    resolution: resolution(
      'docs/errors/PDF_ENCRYPTED.md',
      'Encrypted PDFs are rejected. Filevora does not ask a model to guess the text.',
      [
        action(
          'supply_unlocked',
          'Upload a PDF that does not require a password.',
        ),
      ],
    ),
  },
  OCR_NOT_CONFIGURED: {
    httpStatus: 422,
    category: 'processing',
    retryable: false,
    message: 'The PDF has no extractable text and OCR is not configured.',
    resolution: resolution(
      'docs/errors/OCR_NOT_CONFIGURED.md',
      'No text layer was found. Filevora will not invent text. OCR is an optional adapter and is not bundled.',
      [
        action(
          'configure_ocr',
          'Configure an OCR adapter, or accept the no-text result.',
        ),
      ],
    ),
  },
  SCHEMA_VALIDATION_FAILED: {
    httpStatus: 422,
    category: 'processing',
    retryable: false,
    message: 'The tabular file failed schema validation.',
    resolution: resolution(
      'docs/errors/SCHEMA_VALIDATION_FAILED.md',
      'One or more rows or the header did not match the requested schema. See the row error artifact.',
      [
        action(
          'fix_rows',
          'Correct the source rows or relax the schema. Invalid values are not coerced silently when the policy says collect or fail.',
        ),
      ],
    ),
  },
  RETENTION_POLICY_UNSAFE: {
    httpStatus: 400,
    category: 'config',
    retryable: false,
    message:
      'The retention policy could delete data without an explicit safe rule.',
    resolution: resolution(
      'docs/errors/RETENTION_POLICY_UNSAFE.md',
      'Inactivity deletion needs an evidence source, and age-based deletion must be explicitly enabled. Dry-run before a real sweep.',
      [
        action(
          'dry_run',
          'Run a retention dry-run and review filesEligible before deleting.',
        ),
      ],
    ),
  },
  FEATURE_REQUIRES_STORED_MODE: {
    httpStatus: 400,
    category: 'config',
    retryable: false,
    message: 'This API requires stored metadata mode.',
    resolution: resolution(
      'docs/errors/FEATURE_REQUIRES_STORED_MODE.md',
      'Lite mode keeps bytes in object storage and the queue in Redis. Listing, search, and migrate need the host database.',
      [
        action(
          'set_mode',
          'Set FILEVORA_METADATA_MODE=stored and FILEVORA_DATABASE_URL to the host database.',
          'FILEVORA_METADATA_MODE=stored',
        ),
        action(
          'migrate',
          'Apply the filevora_assets tables on that database.',
          'npx filevora migrate',
        ),
      ],
      'npx filevora doctor --json',
    ),
  },
  ASSET_NOT_FOUND: {
    httpStatus: 404,
    category: 'storage',
    retryable: false,
    message:
      'No object matched {assetId}_original.* for this tenant. Asset ids are not listed from Redis.',
    resolution: resolution(
      'docs/errors/ASSET_NOT_FOUND.md',
      'Lite get-by-id probes object storage for {assetId}_original.{ext} under the tenant prefix. A missing key is not found.',
      [
        action(
          'check_id',
          'Use the assetId returned when the upload session was created, and confirm the original object is in this tenant prefix.',
        ),
      ],
    ),
  },
  FEATURE_NOT_AVAILABLE: {
    httpStatus: 501,
    category: 'config',
    retryable: false,
    message: 'That Filevora feature is not available in this build.',
    resolution: resolution(
      'docs/errors/FEATURE_NOT_AVAILABLE.md',
      'Managed hosting, billing, accounts, and other reserved providers are intentionally unsupported in the open-source package.',
      [
        action(
          'use_self_host',
          'Use filesystem or your own S3 and database. A Filevora account is not required and cannot enable this feature.',
        ),
      ],
    ),
  },
  INVALID_CONFIG: {
    httpStatus: 500,
    category: 'config',
    retryable: false,
    message: 'The Filevora configuration is invalid.',
    resolution: resolution(
      'docs/errors/INVALID_CONFIG.md',
      'Typed options and FILES_* variables failed schema validation or contradict each other.',
      [
        action(
          'validate',
          'Run config validation and fix the reported field.',
          'npx filevora config validate --json',
        ),
      ],
      'npx filevora config validate --json',
    ),
  },
  UNSAFE_PRODUCTION_CONFIG: {
    httpStatus: 500,
    category: 'config',
    retryable: false,
    message:
      'Production configuration is missing an explicit durability acknowledgement or uses ephemeral storage.',
    resolution: resolution(
      'docs/errors/UNSAFE_PRODUCTION_CONFIG.md',
      'Production must name its storage and metadata drivers. Single-host SQLite or filesystem storage must set FILES_SINGLE_HOST_ACK=true. Storage roots under the OS temp directory are rejected.',
      [
        action(
          'ack_storage',
          'Point storage at a persistent disk or set an explicit single-host acknowledgement.',
        ),
      ],
      'npx filevora config validate --json',
    ),
  },
  INVALID_STORAGE_KEY: {
    httpStatus: 400,
    category: 'storage',
    retryable: false,
    message: 'The object key is not allowed.',
    resolution: resolution(
      'docs/errors/INVALID_STORAGE_KEY.md',
      'Object keys are opaque and must stay inside the storage root. User filenames are never used as keys.',
      [
        action(
          'use_ids',
          'Use the file id returned by Filevora. Do not pass paths from the browser.',
        ),
      ],
    ),
  },
  MALWARE_DETECTED: {
    httpStatus: 422,
    category: 'upload',
    retryable: false,
    message: 'The file was rejected by the malware scanner.',
    resolution: resolution(
      'docs/errors/MALWARE_DETECTED.md',
      'The scanner marked the original as infected after it was stored and before encoding. The original was quarantined and no variants were published.',
      [
        action(
          'discard',
          'Do not retry this file. Upload a clean copy if the detection was a false positive.',
        ),
      ],
    ),
  },
  MALWARE_SCAN_FAILED: {
    httpStatus: 503,
    category: 'upload',
    retryable: true,
    message: 'The malware scan did not finish.',
    resolution: resolution(
      'docs/errors/MALWARE_SCAN_FAILED.md',
      'A scanner is configured, but it was unreachable or returned an unusable result. The original was quarantined and encoding did not start.',
      [
        action(
          'check_scanner',
          'Check FILEVORA_CLAMAV_HOST and FILEVORA_CLAMAV_PORT, then upload again.',
        ),
      ],
    ),
  },
  TRANSFORM_REJECTED: {
    httpStatus: 400,
    category: 'processing',
    retryable: false,
    message: 'The asset transform was rejected.',
    resolution: resolution(
      'docs/errors/TRANSFORM_REJECTED.md',
      'The config does not match the sniffed media type, a preset name is unknown, or a crop, trim, or page list is outside the file. context.field is the offending key, context.reason says why, context.detectedType is the sniffed type, context.validOperations lists operations, and context.validPresets lists preset names when the failure is about a preset.',
      [
        action(
          'match_type',
          'Use only the operations listed in validOperations for the detected type.',
        ),
      ],
    ),
  },
  INVALID_RECIPE: {
    httpStatus: 400,
    category: 'processing',
    retryable: false,
    message: 'The processing recipe is not allowed.',
    resolution: resolution(
      'docs/errors/INVALID_RECIPE.md',
      'Transforms must use an allowlisted kind. Arbitrary FFmpeg arguments and shell fragments are rejected.',
      [
        action(
          'use_recipe',
          'Use a named preset or a typed transform from the recipe reference.',
        ),
      ],
    ),
  },
  PROCESSOR_UNAVAILABLE: {
    httpStatus: 501,
    category: 'processing',
    retryable: false,
    message: 'The processor dependency is not installed.',
    resolution: resolution(
      'docs/errors/PROCESSOR_UNAVAILABLE.md',
      'An optional processor such as sharp could not be loaded. Core upload still works without it.',
      [
        action(
          'install_processor',
          'Install the optional dependency named in the error context.',
        ),
      ],
      doctor,
    ),
  },
  JOB_VERSION_UNSUPPORTED: {
    httpStatus: 409,
    category: 'processing',
    retryable: false,
    message: 'The worker cannot run this job schema version.',
    resolution: resolution(
      'docs/errors/JOB_VERSION_UNSUPPORTED.md',
      'The job was written by a newer Filevora schema than this worker.',
      [
        action(
          'upgrade_worker',
          'Deploy a worker with the same or newer Filevora version, then retry the job.',
        ),
      ],
    ),
  },
  IDEMPOTENCY_CONFLICT: {
    httpStatus: 409,
    category: 'upload',
    retryable: false,
    message: 'The idempotency key was already used for a different request.',
    resolution: resolution(
      'docs/errors/IDEMPOTENCY_CONFLICT.md',
      'Repeat the original request body or choose a new idempotency key.',
      [
        action(
          'reuse_or_new',
          'Retry the same payload to receive the original session, or send a new key.',
        ),
      ],
    ),
  },
  CANCELLED: {
    httpStatus: 409,
    category: 'processing',
    retryable: false,
    message: 'The job was cancelled.',
    resolution: resolution(
      'docs/errors/CANCELLED.md',
      'A cancel request stopped the job. Partial outputs were not published.',
      [
        action(
          'enqueue_again',
          'Enqueue a new processing job if the variant is still needed.',
        ),
      ],
    ),
  },
  REMOTE_URL_SCHEME: {
    httpStatus: 400,
    category: 'upload',
    retryable: false,
    message: 'The remote URL must be http or https.',
    resolution: resolution(
      'docs/errors/REMOTE_URL_SCHEME.md',
      'Only http and https are accepted. file, ftp, and other schemes are rejected.',
      [action('use_http', 'Pass an http or https URL with no other scheme.')],
    ),
  },
  REMOTE_URL_CREDENTIALS: {
    httpStatus: 400,
    category: 'upload',
    retryable: false,
    message: 'The remote URL must not include credentials.',
    resolution: resolution(
      'docs/errors/REMOTE_URL_CREDENTIALS.md',
      'A username or password in the URL is rejected so it is not sent or logged.',
      [
        action(
          'strip_userinfo',
          'Remove the username and password from the URL.',
        ),
      ],
    ),
  },
  REMOTE_URL_PORT: {
    httpStatus: 400,
    category: 'upload',
    retryable: false,
    message: 'The remote URL port is not allowed.',
    resolution: resolution(
      'docs/errors/REMOTE_URL_PORT.md',
      'The default allowed ports are 80 and 443. Add the port to FILEVORA_REMOTE_ALLOWED_PORTS when a local server uses another port.',
      [
        action(
          'allow_port',
          'Set FILEVORA_REMOTE_ALLOWED_PORTS to include this port.',
          'FILEVORA_REMOTE_ALLOWED_PORTS=80,443',
        ),
      ],
    ),
  },
  REMOTE_URL_HOST: {
    httpStatus: 400,
    category: 'upload',
    retryable: false,
    message: 'The remote host is not allowed.',
    resolution: resolution(
      'docs/errors/REMOTE_URL_HOST.md',
      'FILEVORA_REMOTE_HOST_DENY always rejects a host. FILEVORA_REMOTE_HOST_ALLOW, when set, rejects every host that is not listed.',
      [action('adjust_hosts', 'Change the host allowlist or denylist.')],
    ),
  },
  REMOTE_URL_BLOCKED: {
    httpStatus: 400,
    category: 'upload',
    retryable: false,
    message: 'The remote address is blocked.',
    resolution: resolution(
      'docs/errors/REMOTE_URL_BLOCKED.md',
      'Loopback, private, link-local, multicast, and cloud metadata addresses are blocked. DNS answers are checked, and the connection uses a checked address. FILEVORA_REMOTE_ALLOW_PRIVATE=true allows private addresses on the URL you pass, not on a redirect.',
      [
        action(
          'public_host',
          'Use a public http or https URL. For a local server, set FILEVORA_REMOTE_ALLOW_PRIVATE=true.',
          'FILEVORA_REMOTE_ALLOW_PRIVATE=true',
        ),
      ],
    ),
  },
  REMOTE_URL_REDIRECT: {
    httpStatus: 400,
    category: 'upload',
    retryable: false,
    message: 'The remote redirect was rejected.',
    resolution: resolution(
      'docs/errors/REMOTE_URL_REDIRECT.md',
      'Each redirect is checked with the same rules. A redirect to a private address is rejected even when private addresses are allowed on the original URL. The hop limit is FILEVORA_REMOTE_MAX_REDIRECTS.',
      [
        action(
          'direct_url',
          'Pass the final public URL, or raise FILEVORA_REMOTE_MAX_REDIRECTS.',
        ),
      ],
    ),
  },
  REMOTE_URL_TIMEOUT: {
    httpStatus: 504,
    category: 'upload',
    retryable: true,
    message: 'The remote download timed out.',
    resolution: resolution(
      'docs/errors/REMOTE_URL_TIMEOUT.md',
      'The connect timeout is FILEVORA_REMOTE_CONNECT_TIMEOUT_MS. The whole download, including redirects, stops at FILEVORA_REMOTE_TIMEOUT_MS.',
      [
        action(
          'raise_timeout',
          'Raise the timeout or retry when the host is slow.',
          'FILEVORA_REMOTE_TIMEOUT_MS=120000',
        ),
      ],
    ),
  },
  WEBHOOK_REJECTED: {
    httpStatus: 400,
    category: 'config',
    retryable: false,
    message: 'The webhook URL was rejected.',
    resolution: resolution(
      'docs/errors/WEBHOOK_REJECTED.md',
      'Webhook targets must be HTTPS in production. Loopback and private addresses are rejected so the worker cannot be used as a proxy.',
      [action('public_https', 'Register an HTTPS endpoint that you control.')],
    ),
  },
  DELIVERY_MALFORMED: {
    httpStatus: 403,
    category: 'auth',
    retryable: false,
    message: 'The delivery token is malformed.',
    resolution: resolution(
      'docs/errors/DELIVERY_MALFORMED.md',
      'The token is not a base64 payload plus an HMAC. It was truncated or was not produced by signUrl.',
      [
        action(
          'sign_again',
          'Call signUrl again and use the returned URL unchanged.',
        ),
      ],
    ),
  },
  DELIVERY_BAD_SIGNATURE: {
    httpStatus: 403,
    category: 'auth',
    retryable: false,
    message: 'The delivery signature is invalid.',
    resolution: resolution(
      'docs/errors/DELIVERY_BAD_SIGNATURE.md',
      'The HMAC does not match any configured signing key. The URL was edited, or it was signed by a key that has been removed.',
      [
        action(
          'check_keys',
          'Keep the previous key in FILEVORA_SIGNING_SECRET while tokens signed with it are still valid.',
        ),
      ],
    ),
  },
  DELIVERY_EXPIRED: {
    httpStatus: 403,
    category: 'auth',
    retryable: false,
    message: 'The delivery URL has expired.',
    resolution: resolution(
      'docs/errors/DELIVERY_EXPIRED.md',
      'exp is in the past. Delivery URLs are short-lived. Request a new one.',
      [action('renew', 'Call signUrl or GET the versions route again.')],
    ),
  },
  DELIVERY_REVOKED: {
    httpStatus: 403,
    category: 'auth',
    retryable: false,
    message: 'The delivery URL was revoked.',
    resolution: resolution(
      'docs/errors/DELIVERY_REVOKED.md',
      'The per-asset url salt changed after this token was signed. Older URLs no longer match.',
      [
        action(
          'sign_again',
          'Issue a new URL. Rotate the salt only when existing links should die.',
        ),
      ],
    ),
  },
  DELIVERY_IP_DENIED: {
    httpStatus: 403,
    category: 'auth',
    retryable: false,
    message: 'The delivery URL is bound to a different IP.',
    resolution: resolution(
      'docs/errors/DELIVERY_IP_DENIED.md',
      'The token contains an ip claim and the request IP does not match it.',
      [
        action(
          'resign',
          'Sign again without ip, or from the client that will fetch the URL.',
        ),
      ],
    ),
  },
  DELIVERY_PRIVATE: {
    httpStatus: 403,
    category: 'auth',
    retryable: false,
    message: 'This asset is private.',
    resolution: resolution(
      'docs/errors/DELIVERY_PRIVATE.md',
      'The plain /public URL is only for visibility public. A missing asset card is private.',
      [
        action(
          'use_signed',
          'Fetch a signed /content URL, or set visibility to public when that is intended.',
        ),
      ],
    ),
  },
  DESCRIPTION_NOT_CONFIGURED: {
    httpStatus: 422,
    category: 'config',
    retryable: false,
    message:
      'A description cannot be created without a Gemini API key. Set FILEVORA_GEMINI_API_KEY.',
    resolution: resolution(
      'docs/errors/DESCRIPTION_NOT_CONFIGURED.md',
      'Filevora sends the asset to Google Gemini only when a key is configured. The asset itself is still stored.',
      [
        action(
          'set_gemini_key',
          'Set FILEVORA_GEMINI_API_KEY to a Google AI Studio key, then retry the description.',
          'export FILEVORA_GEMINI_API_KEY=your-key',
        ),
      ],
    ),
  },
  DESCRIPTION_REQUIRES_DATABASE: {
    httpStatus: 422,
    category: 'config',
    retryable: false,
    message:
      'Descriptions are stored in the database. Lite mode cannot store them. Set FILEVORA_DATABASE_URL.',
    resolution: resolution(
      'docs/errors/DESCRIPTION_REQUIRES_DATABASE.md',
      'Queries over tags stay on the host database. Asset cards and object storage never hold the description text.',
      [
        action(
          'enable_stored_mode',
          'Set FILEVORA_DATABASE_URL to postgres://, mysql://, or sqlite://./filevora.sqlite and run npx filevora migrate.',
          'npx filevora migrate',
        ),
      ],
    ),
  },
  LIST_QUERY_INVALID: {
    httpStatus: 400,
    category: 'config',
    retryable: false,
    message:
      'A list filter is invalid. The error names the parameter and the values it accepts.',
    resolution: resolution(
      'docs/errors/LIST_QUERY_INVALID.md',
      'GET /files rejects an unknown type, sort, date, or range instead of ignoring it.',
      [
        action(
          'fix_list_query',
          'Read the parameter named in the error. type is image, video, document, or audio. sort is created, updated, size, or filename. order is asc or desc.',
        ),
      ],
    ),
  },
  SEARCH_QUERY_INVALID: {
    httpStatus: 400,
    category: 'config',
    retryable: false,
    message:
      'A search field is invalid. The error names the field and the constraint it breaks.',
    resolution: resolution(
      'docs/errors/SEARCH_QUERY_INVALID.md',
      'POST /files/search rejects an empty or oversized query, a minScore outside 0 to 1, a maxResults outside 1 to 1000, an invalid filter, or a cursor that belongs to another query.',
      [
        action(
          'fix_search_query',
          'Read the field named in the error. query is 1 to 2000 characters, minScore is 0 to 1, maxResults is 1 to 1000. Keep the query, minScore, maxResults, and every filter unchanged when you pass nextCursor, or omit cursor to start over.',
        ),
      ],
    ),
  },
  EMBEDDING_UNAVAILABLE: {
    httpStatus: 503,
    category: 'processing',
    retryable: true,
    message:
      'The search query could not be embedded. Retry with backoff; the Gemini embedding call failed or was rate limited.',
    resolution: resolution(
      'docs/errors/EMBEDDING_UNAVAILABLE.md',
      'Search turns the query into a vector with the Gemini embedding model. The call timed out, was rate limited after retries, or returned an unusable vector.',
      [
        action(
          'retry_search',
          'Retry the search after a short delay. If it keeps failing, check FILEVORA_GEMINI_API_KEY, FILEVORA_EMBEDDING_MODEL, and the Gemini quota.',
        ),
      ],
      doctor,
    ),
  },
  DELIVERY_NOT_FOUND: {
    httpStatus: 403,
    category: 'auth',
    retryable: false,
    message: 'The delivery target was not found.',
    resolution: resolution(
      'docs/errors/DELIVERY_NOT_FOUND.md',
      'The asset or version in the token does not exist or was deleted.',
      [
        action(
          'check_version',
          'Use _original or a version name returned by the versions route.',
        ),
      ],
    ),
  },
} as const satisfies Record<string, ErrorSpec>;

for (const spec of Object.values(ERROR_CATALOG)) {
  if (!(ERROR_CATEGORIES as readonly string[]).includes(spec.category)) {
    throw new Error(`Unknown error category ${spec.category}`);
  }
}

export type ErrorCode = keyof typeof ERROR_CATALOG;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as ErrorCode[];
