import { describe, expect, it, vi } from "vitest";

import {
  ProhibitedLogFieldError,
  createDiagnosticSummary,
  createStructuredLogger,
  resolveRequestId,
  sanitizeForLogging,
  type StructuredLogRecord,
} from "../src/index.js";

const deterministicRequestId = (): string => "00000000-0000-7000-8000-000000000001";

describe("deep redaction", () => {
  it("rejects nested正文, prompt, and secret-shaped fields", () => {
    expect(() =>
      sanitizeForLogging({
        projectId: "project-1",
        nested: {
          systemPrompt: "must never be logged",
        },
      }),
    ).toThrow(ProhibitedLogFieldError);

    expect(() =>
      sanitizeForLogging({
        chapterText: "must never be logged",
      }),
    ).toThrow(ProhibitedLogFieldError);

    expect(() =>
      sanitizeForLogging({
        apiKey: "must never be logged",
      }),
    ).toThrow(ProhibitedLogFieldError);
  });

  it("redacts PII and credential-like values at arbitrary depth", () => {
    const value = sanitizeForLogging({
      actor: {
        email: "author@example.com",
        note: "contact author@example.com with Bearer abcdefghijklmnop",
      },
    });

    expect(value).toEqual({
      actor: {
        email: "[REDACTED]",
        note: "contact [REDACTED_EMAIL] with Bearer [REDACTED_CREDENTIAL]",
      },
    });
  });

  it("handles circular objects without throwing or leaking", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(sanitizeForLogging(circular)).toEqual({
      self: "[CIRCULAR]",
    });
  });
});

describe("structured logger", () => {
  it("emits deterministic structured records", () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({
      sink: {
        write: (record) => records.push(record),
      },
      clock: () => new Date("2026-07-27T00:00:00.000Z"),
      requestIdFactory: deterministicRequestId,
      baseContext: {
        component: "test",
      },
    });

    logger.info("generation.started", "Generation started", {
      context: {
        projectId: "project-1",
      },
    });

    expect(records).toEqual([
      {
        timestamp: "2026-07-27T00:00:00.000Z",
        level: "info",
        event: "generation.started",
        message: "Generation started",
        requestId: deterministicRequestId(),
        context: {
          component: "test",
          projectId: "project-1",
        },
      },
    ]);
  });

  it("rejects the complete event before a sink can receive sensitive fields", () => {
    const sink = vi.fn();
    const logger = createStructuredLogger({
      sink: {
        write: sink,
      },
      requestIdFactory: deterministicRequestId,
    });

    expect(() =>
      logger.error("save.failed", "Save failed", {
        context: {
          nested: {
            recoveryCode: "must never be logged",
          },
        },
      }),
    ).toThrow(ProhibitedLogFieldError);
    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects prohibited fields even when the log level is filtered out", () => {
    const logger = createStructuredLogger({
      sink: {
        write: vi.fn(),
      },
      minimumLevel: "error",
      requestIdFactory: deterministicRequestId,
    });

    expect(() =>
      logger.debug("generation.context", "Filtered debug event", {
        context: {
          prompt: "must never be accepted",
        },
      }),
    ).toThrow(ProhibitedLogFieldError);
  });
});

describe("request IDs and diagnostics", () => {
  it("rejects unsafe incoming IDs and creates a safe replacement", () => {
    expect(resolveRequestId("unsafe\nheader", deterministicRequestId)).toBe(
      deterministicRequestId(),
    );
  });

  it("builds a bounded redacted diagnostic summary", () => {
    const summary = createDiagnosticSummary(
      {
        appVersion: "0.1.0",
        platform: "windows",
        environment: "test",
        databaseHealth: "healthy",
        indexHealth: "degraded",
        syncState: "disabled",
        errorCodes: ["INDEX_UNAVAILABLE", "INDEX_UNAVAILABLE"],
        taskStateCounts: {
          queued: 1,
        },
        configuration: {
          dataDirectory: "D:/private/project",
          telemetryEnabled: false,
        },
      },
      {
        clock: () => new Date("2026-07-27T00:00:00.000Z"),
        requestIdFactory: deterministicRequestId,
      },
    );

    expect(summary.configuration).toEqual({
      dataDirectory: "[REDACTED]",
      telemetryEnabled: false,
    });
    expect(summary.errorCodes).toEqual(["INDEX_UNAVAILABLE"]);
  });

  it("refuses diagnostics containing正文 or prompts", () => {
    expect(() =>
      createDiagnosticSummary(
        {
          appVersion: "0.1.0",
          platform: "windows",
          environment: "test",
          databaseHealth: "healthy",
          indexHealth: "healthy",
          syncState: "disabled",
          errorCodes: [],
          taskStateCounts: {},
          configuration: {
            prompt: "must never be included",
          },
        },
        {
          requestIdFactory: deterministicRequestId,
        },
      ),
    ).toThrow(ProhibitedLogFieldError);
  });
});
