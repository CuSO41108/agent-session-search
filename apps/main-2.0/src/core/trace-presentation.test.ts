import { describe, expect, it } from "vitest";
import { traceCompactionSummary } from "./trace-presentation";

describe("traceCompactionSummary", () => {
  it("returns displayable compact statistics", () => {
    expect(traceCompactionSummary({
      compaction: {
        itemCount: 27,
        itemTypes: { message: 26, function_call: 0, compaction: 1 },
        opaqueCompaction: true,
      },
    })).toEqual({
      itemCount: 27,
      itemTypes: [
        { type: "message", count: 26 },
        { type: "compaction", count: 1 },
      ],
      opaqueCompaction: true,
    });
  });

  it("rejects malformed compact statistics", () => {
    expect(traceCompactionSummary(undefined)).toBeNull();
    expect(traceCompactionSummary({ compaction: { itemCount: "27" } })).toBeNull();
  });
});
