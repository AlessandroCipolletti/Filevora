/** Public CLI surface. Help text and the capability manifest both use this list. */
export const CLI_COMMANDS = [
  'capabilities --json',
  'manifest --json',
  'config validate --json',
  'doctor --json',
  'mcp',
  'migrate',
  'cleanup [--dry-run] [--json]',
  'init --profile local-s3',
  'worker',
  '--help',
  '--version',
] as const;
