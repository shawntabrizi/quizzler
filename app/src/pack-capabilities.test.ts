import { describe, expect, it } from "vitest";

import {
    availablePackDifficulties,
    difficultySummary,
    difficultyIndexesFromMask,
    maxPlayableQuestionCount,
} from "./pack-capabilities";

describe("pack capabilities", () => {
    it("describes broad and sparse difficulty coverage without inventing a final tier", () => {
        expect(difficultySummary({ easy: 8, medium: 5, hard: 2 })).toBe("Mixed difficulty");
        expect(difficultySummary({ easy: 8, medium: 0, hard: 0 })).toBe("All Easy");
        expect(difficultySummary({ easy: 8, medium: 5, hard: 0 })).toBe("Easy & Medium");
        expect(availablePackDifficulties({ easy: 0, medium: 2, hard: 1 })).toEqual([1, 2]);
        expect(difficultyIndexesFromMask(0b101)).toEqual([0, 2]);
    });

    it("always reserves one distinct question for the final", () => {
        expect(maxPlayableQuestionCount(1, 20)).toBe(0);
        expect(maxPlayableQuestionCount(2, 20)).toBe(1);
        expect(maxPlayableQuestionCount(21, 20)).toBe(20);
        expect(maxPlayableQuestionCount(255, 20)).toBe(20);
    });
});
