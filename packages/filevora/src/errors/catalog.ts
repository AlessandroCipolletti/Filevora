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
} as const satisfies Record<string, ErrorSpec>;

for (const spec of Object.values(ERROR_CATALOG)) {
  if (!(ERROR_CATEGORIES as readonly string[]).includes(spec.category)) {
    throw new Error(`Unknown error category ${spec.category}`);
  }
}

export type ErrorCode = keyof typeof ERROR_CATALOG;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as ErrorCode[];
