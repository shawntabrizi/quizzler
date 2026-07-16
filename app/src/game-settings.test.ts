import { describe, expect, it } from "vitest";

import { ANSWER_BLOCK_PRESETS, presetLabel } from "./game-config";
import {
    gamePaceLabel,
    gameProgressLabel,
    playerCountLabel,
    questionCountLabel,
    reviewContinueLabel,
} from "./game-settings";

describe("game settings labels", () => {
    it("uses the human-friendly pace preset instead of raw block counts", () => {
        expect(gamePaceLabel(ANSWER_BLOCK_PRESETS[1]!.blocks, ANSWER_BLOCK_PRESETS))
            .toBe(presetLabel(ANSWER_BLOCK_PRESETS[1]!));
        expect(gamePaceLabel(999, ANSWER_BLOCK_PRESETS)).toBe("Custom pace");
    });

    it("describes game stages in player terms", () => {
        expect(gameProgressLabel(0, 0, 5)).toBe("Lobby · waiting to start");
        expect(gameProgressLabel(1, 2, 5)).toBe("Question 3 of 5");
        expect(gameProgressLabel(4, 0, 5)).toBe("Setting final wagers");
        expect(gameProgressLabel(6, 0, 5)).toBe("Reviewing the final question");
    });

    it("handles singular and inactive-player labels", () => {
        expect(questionCountLabel(1)).toBe("1 question");
        expect(questionCountLabel(5)).toBe("5 questions");
        expect(playerCountLabel(1, 1)).toBe("1 active player");
        expect(playerCountLabel(2, 3)).toBe("2 active players of 3 total");
    });

    it("names the regular-review transition into the final round", () => {
        expect(reviewContinueLabel(2, 3, 5)).toBe("Ready for next question");
        expect(reviewContinueLabel(2, 4, 5)).toBe("Choose final difficulty");
    });
});
