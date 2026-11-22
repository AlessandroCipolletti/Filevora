const SECRET_KEY =
  /key|secret|token|password|authorization|credential|postgres|connectionstring|cookie/i;
const SECRET_VALUE =
  /(?:sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/-]+=*|postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@)/gi;

const MAX_STRING = 180;
const MAX_DEPTH = 6;
const MAX_KEYS = 40;

/**
 * Redact secrets from a value before it is logged, returned as error context,
 * or sent to an optional diagnostics explainer.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value))
    return value.slice(0, MAX_KEYS).map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      MAX_KEYS,
    );
    for (const [key, entry] of entries) {
      output[key] = SECRET_KEY.test(key)
        ? '[redacted]'
        : redactValue(entry, depth + 1);
    }
    return output;
  }
  return '[unsupported]';
}

/** Replace credential-shaped substrings. Bounded so error payloads stay small. */
export function redactString(value: string): string {
  const redacted = value.replace(SECRET_VALUE, '[redacted]');
  if (redacted.length <= MAX_STRING) return redacted;
  return `${redacted.slice(0, MAX_STRING)}…`;
}
