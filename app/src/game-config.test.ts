import { describe, expect, it } from "vitest";

import {
    ANSWER_BLOCK_PRESETS,
    MAX_LOBBY_PLAYERS,
    MAX_STAGE_BLOCKS,
    MIN_STAGE_BLOCKS,
    REVIEW_BLOCK_PRESETS,
    isAllowedBlockPreset,
    presetLabel,
    questionCountOptions,
} from "./game-config";

describe("game configuration presets", () => {
    it("only encodes contract-valid durations while keeping labels friendly", () => {
        for (const preset of [...ANSWER_BLOCK_PRESETS, ...REVIEW_BLOCK_PRESETS]) {
            expect(preset.blocks).toBeGreaterThanOrEqual(MIN_STAGE_BLOCKS);
            expect(preset.blocks).toBeLessThanOrEqual(MAX_STAGE_BLOCKS);
            expect(presetLabel(preset)).not.toContain("block");
        }
        expect(presetLabel({ name: "Standard", blocks: 30 })).toBe("Standard · ~1 min");
        expect(presetLabel({ name: "Relaxed", blocks: 45 })).toBe("Relaxed · ~1 min 30 sec");
    });

    it("keeps one non-configurable contract safety ceiling for lobbies", () => {
        expect(MAX_LOBBY_PLAYERS).toBe(24);
    });

    it("caps question choices to the selected pack", () => {
        expect(questionCountOptions(1)).toEqual([1]);
        expect(questionCountOptions(4)).toEqual([1, 2, 3, 4]);
        expect(questionCountOptions(0)).toEqual([]);
    });

    it("recognizes only the configured duration choices", () => {
        expect(isAllowedBlockPreset(30, ANSWER_BLOCK_PRESETS)).toBe(true);
        expect(isAllowedBlockPreset(31, ANSWER_BLOCK_PRESETS)).toBe(false);
    });
});
