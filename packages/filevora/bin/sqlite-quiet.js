import process from 'node:process';

const emit = process.emit.bind(process);
process.emit = function (event, ...args) {
  const warning = args[0];
  if (
    event === 'warning' &&
    warning &&
    typeof warning === 'object' &&
    warning.name === 'ExperimentalWarning' &&
    String(warning.message ?? '').includes('SQLite')
  ) {
    return false;
  }
  return Reflect.apply(emit, process, [event, ...args]);
};
