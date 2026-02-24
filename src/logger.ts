type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function formatMessage(level: LogLevel, prefix: string, msg: string): string {
  const timestamp = new Date().toISOString();
  const logLevelStr = level.toUpperCase();
  return `[${timestamp}] [${logLevelStr}] [${prefix}] ${msg}`;
}

function shouldLogMessage(currentLevel: LogLevel, messageLevel: LogLevel): boolean {
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  return levels.indexOf(messageLevel) >= levels.indexOf(currentLevel);
}

function createLogger(prefix: string) {
  const logLevelEnv = process.env.LOG_LEVEL as LogLevel;
  const logLevel: LogLevel = logLevelEnv || 'info';

  return {
    info(msg: string) {
      if (shouldLogMessage(logLevel, 'info')) {
        console.info(formatMessage('info', prefix, msg));
      }
    },
    warn(msg: string) {
      if (shouldLogMessage(logLevel, 'warn')) {
        console.warn(formatMessage('warn', prefix, msg));
      }
    },
    error(msg: string) {
      if (shouldLogMessage(logLevel, 'error')) {
        console.error(formatMessage('error', prefix, msg));
      }
    },
    debug(msg: string) {
      if (shouldLogMessage(logLevel, 'debug')) {
        console.debug(formatMessage('debug', prefix, msg));
      }
    }
  };
}

export { createLogger, LogLevel };
