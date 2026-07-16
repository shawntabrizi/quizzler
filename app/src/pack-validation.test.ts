import { describe, expect, it } from "vitest";
import { normalizeAcceptedAnswers, validatePack } from "./pack-validation";

describe("pack validation", () => {
    it("deduplicates folded answers before applying the registry cap", () => {
        expect(normalizeAcceptedAnswers(["Café", "cafe", "CAFE"])).toEqual(["cafe"]);
    });

    it("accepts a valid authored pack", () => {
        expect(validatePack({
            title: "Friday trivia",
            questions: [
                { text: "Where is the Eiffel Tower?", answers: ["Paris"], difficulty: "easy" },
                { text: "Which river runs through Paris?", answers: ["Seine"], difficulty: "medium" },
            ],
        })).toMatchObject({
            title: "Friday trivia",
            questions: [
                { answers: ["Paris"], difficulty: "easy" },
                { answers: ["Seine"], difficulty: "medium" },
            ],
        });
    });

    it("accepts the 255-question protocol maximum and rejects one more", () => {
        const questions = (count: number) => Array.from({ length: count }, (_, index) => ({
            text: `Question ${index + 1}`,
            answers: ["Answer"],
            difficulty: "easy" as const,
        }));

        expect(validatePack({ title: "Full pack", questions: questions(255) }).questions).toHaveLength(255);
        expect(() => validatePack({ title: "Too large", questions: questions(256) })).toThrow("expected 2–255 questions");
    });

    it("rejects malformed and unusable content before a chain transaction", () => {
        expect(() => validatePack({ title: "", questions: [] }, "bad-pack")).toThrow("title");
        expect(() => validatePack({
            title: "Valid title",
            questions: [
                { text: "Question", answers: ["!!!"], difficulty: "easy" },
                { text: "Question two", answers: ["Answer"], difficulty: "easy" },
            ],
        }, "bad-pack")).toThrow("invalid accepted answer");
        expect(() => validatePack({
            title: "Valid title",
            questions: [{ text: "Only one", answers: ["Answer"], difficulty: "easy" }],
        }, "bad-pack")).toThrow("expected 2");
        expect(() => validatePack({
            title: "Valid title",
            questions: [
                { text: "One", answers: ["Answer"], difficulty: "easy" },
                { text: "Two", answers: ["Answer"], difficulty: "unknown" },
            ],
        }, "bad-pack")).toThrow("easy/medium/hard");
    });
});
