import { describe, expect, it } from "vitest";
import { formatCountLine } from "../src/format.js";

describe("formatCountLine", () => {
  it("does not mark an exact known total as truncated", () => {
    expect(formatCountLine({ count: 2, limit: 2, totalCount: 2 })).toBe(
      "count: 2",
    );
  });

  it("marks an exact limit as possibly truncated when total is unknown", () => {
    expect(formatCountLine({ count: 2, limit: 2 })).toBe(
      "count: 2 (showing first 2)",
    );
  });
});
