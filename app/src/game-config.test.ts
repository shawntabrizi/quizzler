import { describe, expect, it } from "vitest";

import {
    ANSWER_BLOCK_PRESETS,
    BLOCK_SECONDS_ESTIMATE,
    MAX_LOBBY_PLAYERS,
    MAX_STAGE_BLOCKS,
    MIN_STAGE_BLOCKS,
    REVIEW_BLOCK_PRESETS,
    countdownLabel,
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

    it("offers compact, pack-bounded question choices", () => {
        expect(questionCountOptions(1)).toEqual([1]);
        expect(questionCountOptions(4)).toEqual([1, 2, 3, 4]);
        expect(questionCountOptions(6)).toEqual([5, 6]);
        expect(questionCountOptions(13)).toEqual([5, 10, 13]);
        expect(questionCountOptions(20)).toEqual([5, 10, 15, 20]);
        expect(questionCountOptions(0)).toEqual([]);
    });

    it("recognizes only the configured duration choices", () => {
        expect(isAllowedBlockPreset(30, ANSWER_BLOCK_PRESETS)).toBe(true);
        expect(isAllowedBlockPreset(31, ANSWER_BLOCK_PRESETS)).toBe(false);
    });
});

describe("countdown label", () => {
    it("renders nothing for the contract's no-deadline sentinel", () => {
        // Lobby/finished stages use 2^64-1; anything >= 2^63 means "no timer",
        // not a very long countdown.
        expect(countdownLabel(2n ** 64n - 1n, 0n, 0)).toBe("");
        expect(countdownLabel(2n ** 63n, 0n, 0)).toBe("");
    });

    it("extrapolates blocks from wall time between polls", () => {
        // The snapshot said 10 blocks remain. After ~3 blocks of wall time the
        // countdown must keep moving even though no new poll has landed.
        const perBlockMs = BLOCK_SECONDS_ESTIMATE * 1_000;
        expect(countdownLabel(110n, 100n, 0)).toBe(`~${10 * BLOCK_SECONDS_ESTIMATE}s`);
        expect(countdownLabel(110n, 100n, 3 * perBlockMs)).toBe(`~${7 * BLOCK_SECONDS_ESTIMATE}s`);
    });

    it("announces expiry instead of counting into negatives", () => {
        expect(countdownLabel(110n, 110n, 0)).toBe("Time’s up");
        expect(countdownLabel(110n, 100n, 20 * BLOCK_SECONDS_ESTIMATE * 1_000)).toBe("Time’s up");
    });
});
