import { describe, expect, it } from "vitest";

import { formatNaturalLocalTime } from "./natural-local-time";

describe("natural local time", () => {
  it("shows a local Chinese date without exposing an ISO timestamp or seconds", () => {
    const formatted = formatNaturalLocalTime("2026-08-24T01:02:03.456Z");

    expect(formatted).toContain("2026");
    expect(formatted).not.toContain("T01:02:03.456Z");
    expect(formatted).not.toContain("03.456");
    expect(formatted).toMatch(/年/u);
    expect(formatted).toMatch(/月/u);
    expect(formatted).toMatch(/日/u);
  });

  it("uses an honest fallback for an invalid value", () => {
    expect(formatNaturalLocalTime("not-a-date")).toBe("时间未知");
  });
});
