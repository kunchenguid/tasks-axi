import { describe, expect, it } from "vitest";
import { ID_RE } from "../src/backends/markdown-grammar.js";
import { mintId, validateId } from "../src/id.js";

describe("id", () => {
  describe("validateId", () => {
    it("accepts slug-shaped ids", () => {
      expect(validateId("homemux-h7")).toBe("homemux-h7");
      expect(validateId("nm-release-validation")).toBe("nm-release-validation");
      expect(validateId("a.b_c-1")).toBe("a.b_c-1");
    });

    it("rejects ids with spaces or punctuation", () => {
      expect(() => validateId("Bad Id!")).toThrow();
      expect(() => validateId("has space")).toThrow();
      expect(() => validateId("")).toThrow();
    });
  });

  describe("mintId", () => {
    it("mints a recognizable slug-xx id from a title", () => {
      const id = mintId("Fix the summary toggle");
      expect(ID_RE.test(id)).toBe(true);
      expect(id).toMatch(/^fix-the-summary-toggle-[0-9a-f]{2}$/);
    });

    it("namespaces with a prefix", () => {
      const id = mintId("do a thing", "lavish");
      expect(id).toMatch(/^lavish-do-a-thing-[0-9a-f]{2}$/);
    });

    it("falls back to a base when the title has no slug characters", () => {
      const id = mintId("!!!");
      expect(ID_RE.test(id)).toBe(true);
      expect(id).toMatch(/^task-[0-9a-f]{2}$/);
    });
  });
});
