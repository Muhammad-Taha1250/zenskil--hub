import { Injectable, LoggerService, LogLevel } from '@nestjs/common';
import { currentRequestId } from './request-context';
import { sanitizeMeta } from '../utils/sanitize';

// Structured JSON logger. Every line carries a timestamp, level, context,
// and the ambient requestId when one is set. Secrets are redacted before
// they can reach the log stream.
@Injectable()
export class JsonLogger implements LoggerService {
  private level: LogLevel = 'log';
  private readonly levels: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private enabled(level: LogLevel): boolean {
    return this.levels.indexOf(level) >= this.levels.indexOf(this.level);
  }

  private write(level: LogLevel, message: unknown, context?: string, meta?: Record<string, unknown>): void {
    if (!this.enabled(level)) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      context: context ?? 'app',
      requestId: currentRequestId(),
      message: typeof message === 'string' ? message : JSON.stringify(message),
      ...(meta ? { meta: sanitizeMeta(meta) } : {}),
    };
    const out = level === 'error' || level === 'fatal' ? process.stderr : process.stdout;
    out.write(JSON.stringify(line) + '\n');
  }

  log(message: unknown, context?: string, meta?: Record<string, unknown>): void {
    this.write('log', message, context, meta);
  }
  error(message: unknown, context?: string, meta?: Record<string, unknown>): void {
    this.write('error', message, context, meta);
  }
  warn(message: unknown, context?: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, context, meta);
  }
  debug(message: unknown, context?: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, context, meta);
  }
  verbose(message: unknown, context?: string, meta?: Record<string, unknown>): void {
    this.write('verbose', message, context, meta);
  }
  fatal(message: unknown, context?: string, meta?: Record<string, unknown>): void {
    this.write('fatal', message, context, meta);
  }
}
