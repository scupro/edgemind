import { describe, expect, it } from "vitest";
import { scrubNul } from "../src/db/client";

describe("scrubNul", () => {
  it("removes raw NUL characters from strings", () => {
    expect(scrubNul("a\u0000b\u0000")).toBe("ab");
  });
  it("replaces the JSON escape \\u0000 so jsonb accepts the value", () => {
    const json = JSON.stringify({ out: "a\u0000b" });
    const out = scrubNul(json) as string;
    expect(out).not.toContain("\\u0000");
    expect(JSON.parse(out)).toEqual({ out: "a\u2400b" });
  });
  it("keeps an escaped backslash followed by literal u0000 text", () => {
    const json = JSON.stringify({ lit: "x\\u0000y" });
    expect(scrubNul(json)).toBe(json);
  });
  it("walks arrays and plain objects and leaves other values alone", () => {
    const d = new Date(0);
    expect(scrubNul(["a\u0000", { k: "b\u0000" }, 1, null, d])).toEqual(["a", { k: "b" }, 1, null, d]);
  });
});
