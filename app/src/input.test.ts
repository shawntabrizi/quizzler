import { describe, expect, it } from "vitest";
import { parseGameCode, parseIntegerInRange, utf8ByteLength } from "./input";

describe("parseIntegerInRange", () => {
    it("accepts whole decimal values in range", () => {
        expect(parseIntegerInRange(" 12 ", 1, 20)).toBe(12);
        expect(parseIntegerInRange("0", 0, 0)).toBe(0);
    });

    it("rejects empty, fractional, non-decimal, and unsafe values", () => {
        for (const value of ["", "-1", "1.5", "1e2", "abc", "9007199254740992"]) {
            expect(parseIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER)).toBeNull();
        }
    });

    it("enforces inclusive limits", () => {
        expect(parseIntegerInRange("1", 2, 10)).toBeNull();
        expect(parseIntegerInRange("11", 2, 10)).toBeNull();
    });
});

describe("parseGameCode", () => {
    it("only accepts six-digit join codes", () => {
        expect(parseGameCode("100000")).toBe(100000n);
        expect(parseGameCode("999999")).toBe(999999n);
        expect(parseGameCode("99999")).toBeNull();
        expect(parseGameCode("1000000")).toBeNull();
        expect(parseGameCode("not a code")).toBeNull();
    });
});

describe("utf8ByteLength", () => {
    it("counts encoded bytes rather than UTF-16 code units", () => {
        expect(utf8ByteLength("hello")).toBe(5);
        expect(utf8ByteLength("é")).toBe(2);
        expect(utf8ByteLength("🙂")).toBe(4);
    });
});
