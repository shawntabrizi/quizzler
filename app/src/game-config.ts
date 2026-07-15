/**
 * The contract stores durations as block counts. Seconds are only a live
 * pacing estimate for people, never a value we encode on-chain.
 */
export const BLOCK_SECONDS_ESTIMATE = 2;
export const MIN_STAGE_BLOCKS = 2;
export const MAX_STAGE_BLOCKS = 600;

export interface BlockPreset {
    blocks: number;
    name: string;
}

/** Room to think, without making a casual party round drag on. */
export const ANSWER_BLOCK_PRESETS: readonly BlockPreset[] = [
    { blocks: 15, name: "Quick" },
    { blocks: 30, name: "Standard" },
    { blocks: 45, name: "Relaxed" },
    { blocks: 60, name: "Leisurely" },
];

/** Review applies to answer review, the final-difficulty vote, and final review. */
export const REVIEW_BLOCK_PRESETS: readonly BlockPreset[] = [
    { blocks: 6, name: "Quick" },
    { blocks: 12, name: "Standard" },
    { blocks: 18, name: "Discuss" },
    { blocks: 30, name: "Take your time" },
];

/** Fixed safety ceiling enforced by the game contract, never a host setting. */
export const MAX_LOBBY_PLAYERS = 24;

function durationLabel(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes === 0) return `~${seconds} sec`;
    if (remainder === 0) return `~${minutes} min`;
    return `~${minutes} min ${remainder} sec`;
}

/** A friendly label for the UI; the encoded block count remains internal. */
export function presetLabel(preset: BlockPreset): string {
    const seconds = preset.blocks * BLOCK_SECONDS_ESTIMATE;
    return `${preset.name} · ${durationLabel(seconds)}`;
}

export function questionCountOptions(maxQuestions: number): number[] {
    return Array.from({ length: Math.max(0, maxQuestions) }, (_, index) => index + 1);
}

export function isAllowedBlockPreset(value: number, presets: readonly BlockPreset[]): boolean {
    return presets.some((preset) => preset.blocks === value);
}
