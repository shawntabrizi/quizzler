import { describe, expect, it } from "vitest";
import { normalizeAcceptedAnswers, validatePack } from "./pack-validation";

const finalQuestion = { text: "What is 2 + 2?", answers: ["4"] };

describe("pack validation", () => {
    it("deduplicates folded answers before applying the registry cap", () => {
        expect(normalizeAcceptedAnswers(["Café", "cafe", "CAFE"])).toEqual(["cafe"]);
    });

    it("accepts a valid authored pack", () => {
        expect(validatePack({
            title: "Friday trivia",
            questions: [{ text: "Where is the Eiffel Tower?", answers: ["Paris"] }],
            finals: { easy: finalQuestion, medium: finalQuestion, hard: finalQuestion },
        })).toMatchObject({ title: "Friday trivia", questions: [{ answers: ["Paris"] }] });
    });

    it("rejects malformed and unusable content before a chain transaction", () => {
        expect(() => validatePack({ title: "", questions: [], finals: {} }, "bad-pack")).toThrow("title");
        expect(() => validatePack({
            title: "Valid title",
            questions: [{ text: "Question", answers: ["!!!"] }],
            finals: { easy: finalQuestion, medium: finalQuestion, hard: finalQuestion },
        }, "bad-pack")).toThrow("invalid accepted answer");
    });
});
