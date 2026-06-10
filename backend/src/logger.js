export function createLogger(scope, { now = () => new Date() } = {}) {
  function write(level, event, fields = {}) {
    const line = {
      ts: now().toISOString(),
      level,
      scope,
      event,
      ...fields,
    };
    const output = JSON.stringify(line, jsonReplacer);
    if (level === 'error' || level === 'warn') console.error(output);
    else console.log(output);
  }

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

export function errorFields(error) {
  if (!error) return {};
  return {
    error: error.message || String(error),
    errorName: error.name || undefined,
    stack: process.env.LOG_STACKS === 'true' ? error.stack : undefined,
  };
}

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined) return undefined;
  return value;
}
