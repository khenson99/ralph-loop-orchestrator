import pino, { type LoggerOptions } from 'pino';

export function createLogger(level: LoggerOptions['level']) {
  return pino({
    level,
    transport:
      process.env.NODE_ENV !== 'production'
        ? {
            target: 'pino-pretty',
            options: {
              translateTime: 'SYS:standard',
              colorize: true,
            },
          }
        : undefined,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'headers.authorization',
        'headers["x-api-key"]',
        '*.apiKey',
        '*.privateKey',
      ],
      censor: '[REDACTED]',
    },
  });
}
