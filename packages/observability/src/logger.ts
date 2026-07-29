import { sanitizeForLogging, type SafeLogObject, type SafeLogValue } from "./redaction.js";
import { resolveRequestId, type RequestIdFactory } from "./request-id.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Readonly<Record<string, unknown>>;

export interface StructuredLogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly message: string;
  readonly requestId: string;
  readonly context?: SafeLogObject;
}

export interface LogSink {
  write(record: StructuredLogRecord): void;
}

export interface LogWriteOptions {
  readonly requestId?: string;
  readonly context?: LogContext;
}

export interface StructuredLogger {
  debug(event: string, message: string, options?: LogWriteOptions): void;
  info(event: string, message: string, options?: LogWriteOptions): void;
  warn(event: string, message: string, options?: LogWriteOptions): void;
  error(event: string, message: string, options?: LogWriteOptions): void;
  child(context: LogContext): StructuredLogger;
}

export interface LoggerOptions {
  readonly sink: LogSink;
  readonly minimumLevel?: LogLevel | "silent";
  readonly clock?: () => Date;
  readonly requestIdFactory?: RequestIdFactory;
  readonly baseContext?: LogContext;
}

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function isSafeLogObject(value: SafeLogValue): value is SafeLogObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEvent(event: string): void {
  if (!/^[a-z][a-z0-9_.-]{2,127}$/.test(event)) {
    throw new Error("Log events must be stable lowercase identifiers, not user content.");
  }
}

export function createStructuredLogger(options: LoggerOptions): StructuredLogger {
  const minimumLevel = options.minimumLevel ?? "info";
  const clock = options.clock ?? (() => new Date());
  const baseContext = options.baseContext ?? {};
  sanitizeForLogging(baseContext);

  const shouldWrite = (level: LogLevel): boolean =>
    minimumLevel !== "silent" && LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minimumLevel];

  const write = (
    level: LogLevel,
    event: string,
    message: string,
    writeOptions: LogWriteOptions = {},
  ): void => {
    validateEvent(event);
    const safeMessage = sanitizeForLogging(message);
    if (typeof safeMessage !== "string") {
      throw new Error("Log messages must sanitize to strings.");
    }

    const mergedContext = {
      ...baseContext,
      ...(writeOptions.context ?? {}),
    };
    const safeContextValue = sanitizeForLogging(mergedContext);
    if (!isSafeLogObject(safeContextValue)) {
      throw new Error("Log context must sanitize to an object.");
    }

    if (!shouldWrite(level)) {
      return;
    }

    const recordBase = {
      timestamp: clock().toISOString(),
      level,
      event,
      message: safeMessage,
      requestId: resolveRequestId(writeOptions.requestId, options.requestIdFactory),
    } as const;

    options.sink.write(
      Object.keys(safeContextValue).length === 0
        ? recordBase
        : {
            ...recordBase,
            context: safeContextValue,
          },
    );
  };

  const logger: StructuredLogger = {
    debug: (event, message, writeOptions) => write("debug", event, message, writeOptions),
    info: (event, message, writeOptions) => write("info", event, message, writeOptions),
    warn: (event, message, writeOptions) => write("warn", event, message, writeOptions),
    error: (event, message, writeOptions) => write("error", event, message, writeOptions),
    child: (context) =>
      createStructuredLogger({
        ...options,
        baseContext: {
          ...baseContext,
          ...context,
        },
      }),
  };

  return logger;
}

export function createJsonLineSink(writeLine: (line: string) => void): LogSink {
  return {
    write(record) {
      writeLine(JSON.stringify(record));
    },
  };
}
