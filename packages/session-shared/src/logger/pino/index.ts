/**
 * Node-only pino-backed Logger implementation.
 * Import from '@gugu/session-shared/logger/pino' — never from the renderer bundle.
 */

import pinoLib from 'pino';
import { resolveLogLevel } from '../level';
import { prepareFields } from '../prepare';
import { DEFAULT_REDACT_PATHS } from '../redact';
import type { LogFields, LogLevel, Logger } from '../types';

export interface PinoLoggerOptions {
  envLevel?: string;
  debugFlag?: boolean;
  bindings?: LogFields;
  /**
   * pino destination stream (e.g. from createFileTransport or pino.destination).
   * Omit to use pino's default stdout transport.
   */
  destination?: pinoLib.DestinationStream;
  /**
   * Additional field paths to redact via pino.
   * Merged with DEFAULT_REDACT_PATHS.
   */
  extraRedactPaths?: string[];
}

export function createPinoLogger(opts: PinoLoggerOptions = {}): Logger {
  const level = resolveLogLevel({ envLevel: opts.envLevel, debugFlag: opts.debugFlag });

  const redactPaths = [...DEFAULT_REDACT_PATHS, ...(opts.extraRedactPaths ?? [])];

  const pinoOpts: pinoLib.LoggerOptions = {
    level,
    base: opts.bindings ?? {},
    timestamp: pinoLib.stdTimeFunctions.isoTime,
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  const pino = opts.destination ? pinoLib(pinoOpts, opts.destination) : pinoLib(pinoOpts);

  return wrapPino(pino, level);
}

function wrapPino(pino: pinoLib.Logger, level: LogLevel): Logger {
  function emit(at: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: LogFields): void {
    // A level that is off writes nothing, so its fields are not walked either: a debug line on a hot path costs nothing.
    if (!pino.isLevelEnabled(at)) return;
    const prepared = fields ? (prepareFields(fields) as object) : undefined;
    if (prepared) {
      pino[at](prepared, message);
    } else {
      pino[at](message);
    }
  }

  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (bindings) => {
      const prepared = prepareFields(bindings) as object;
      return wrapPino(pino.child(prepared), level);
    },
  };
}
