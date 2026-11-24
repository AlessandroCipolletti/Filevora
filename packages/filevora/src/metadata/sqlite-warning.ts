const emit = process.emit.bind(process);

/** Node 22 prints ExperimentalWarning for node:sqlite on every import. The API is the one this package requires. */
process.emit = ((event: string | symbol, ...args: unknown[]) => {
  const warning = args[0] as { name?: string; message?: string } | undefined;
  if (
    event === 'warning' &&
    warning?.name === 'ExperimentalWarning' &&
    String(warning.message ?? '').includes('SQLite')
  ) {
    return false;
  }
  return Reflect.apply(emit, process, [event, ...args]) as boolean;
}) as typeof process.emit;
