import { describe, expect, it } from "vitest";
import vectors from "../../shared/answer-test-vectors.json";
import { normalizeAnswer } from "./normalize";

describe("normalizeAnswer parity with contract", () => {
    for (const v of vectors.normalize) {
        // The client folds diacritics before the shared algorithm; vectors
        // carry `clientNormalized` where that makes the result differ from
        // the contract's.
        const expected = (v as { clientNormalized?: string }).clientNormalized ?? v.normalized;
        it(`${JSON.stringify(v.raw)} → ${JSON.stringify(expected)}`, () => {
            expect(normalizeAnswer(v.raw)).toBe(expected);
        });
    }
});
