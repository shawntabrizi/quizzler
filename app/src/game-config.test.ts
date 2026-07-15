import { describe, expect, it } from "vitest";

import {
    ANSWER_BLOCK_PRESETS,
    MAX_STAGE_BLOCKS,
    MIN_STAGE_BLOCKS,
    PLAYER_CAP_PRESETS,
    REVIEW_BLOCK_PRESETS,
    isAllowedBlockPreset,
    presetLabel,
    questionCountOptions,
} from "./game-config";

describe("game configuration presets", () => {
    it("only offers contract-valid exact block durations", () => {
        for (const preset of [...ANSWER_BLOCK_PRESETS, ...REVIEW_BLOCK_PRESETS]) {
            expect(preset.blocks).toBeGreaterThanOrEqual(MIN_STAGE_BLOCKS);
            expect(preset.blocks).toBeLessThanOrEqual(MAX_STAGE_BLOCKS);
            expect(presetLabel(preset)).toContain(`${preset.blocks} blocks`);
        }
    });

    it("uses a compact set of useful player caps", () => {
        expect(PLAYER_CAP_PRESETS).toEqual([1, 2, 4, 6, 8, 12, 16]);
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
