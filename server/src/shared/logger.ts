import pino from 'pino';
import { config } from './config';

/**
 * Async, buffered structured logger (the hardened path). The naive "sync_verbose"
 * logging mode bypasses this and uses console.log — see shared/server.ts.
 */
export const logDestination = pino.destination({ dest: 1, sync: false, minLength: 4096 });

export const logger = pino(
  {
    level: config.logLevel,
    base: { service: config.service },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  logDestination,
);

export function flushLogs() {
  try {
    logDestination.flushSync();
  } catch {
    /* destination not ready */
  }
}
