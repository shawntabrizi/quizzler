import { PACK_DIFFICULTIES, type PackDifficulty } from "./pack-validation";

/**
 * Pack capability helpers shared by the picker, setup flow, and game UI.
 *
 * A final question is now an unused normal question, not a separate content
 * type. The game exposes only difficulty tiers that still have an unused
 * candidate after its regular-round plan is made.
 */
export { PACK_DIFFICULTIES, type PackDifficulty };

export const PACK_DIFFICULTY_NAMES: readonly string[] = ["Easy", "Medium", "Hard"];

export interface PackDifficultyCounts {
    easy: number;
    medium: number;
    hard: number;
}

export const EMPTY_DIFFICULTY_COUNTS: Readonly<PackDifficultyCounts> = Object.freeze({
    easy: 0,
    medium: 0,
    hard: 0,
});

function safeCount(value: unknown): number {
    const count = Number(value);
    return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

/** Coerce a decoded contract view into stable, non-negative UI counts. */
export function packDifficultyCounts(value: Partial<PackDifficultyCounts>): PackDifficultyCounts {
    return {
        easy: safeCount(value.easy),
        medium: safeCount(value.medium),
        hard: safeCount(value.hard),
    };
}

export function difficultyCount(counts: PackDifficultyCounts, difficulty: number): number {
    const key = PACK_DIFFICULTIES[difficulty];
    return key === undefined ? 0 : counts[key];
}

/** Difficulty tiers represented somewhere in a pack. */
export function availablePackDifficulties(counts: PackDifficultyCounts): number[] {
    return PACK_DIFFICULTIES.flatMap((difficulty, index) => counts[difficulty] > 0 ? [index] : []);
}

/** Decode the registry/game's compact easy/medium/hard capability bitmask. */
export function difficultyIndexesFromMask(mask: unknown): number[] {
    const value = Number(mask);
    if (!Number.isSafeInteger(value) || value < 0) return [];
    return PACK_DIFFICULTIES.flatMap((_difficulty, index) => (value & (1 << index)) !== 0 ? [index] : []);
}

export function hasMixedDifficulty(counts: PackDifficultyCounts): boolean {
    return availablePackDifficulties(counts).length > 1;
}

/** A concise, human-facing summary for cards and setup. */
export function difficultySummary(counts: PackDifficultyCounts): string {
    const available = availablePackDifficulties(counts);
    if (available.length === 0) return "No questions";
    if (available.length === PACK_DIFFICULTIES.length) return "Mixed difficulty";
    if (available.length === 1) return `All ${PACK_DIFFICULTY_NAMES[available[0]]}`;
    return available.map((difficulty) => PACK_DIFFICULTY_NAMES[difficulty]).join(" & ");
}

/**
 * Every game needs at least one ordinary round plus one different question
 * held back for the final. The contract enforces the same invariant.
 */
export function maxPlayableQuestionCount(totalQuestions: number, gameCeiling: number): number {
    const total = safeCount(totalQuestions);
    const ceiling = Math.max(0, Math.floor(gameCeiling));
    return Math.min(ceiling, Math.max(0, total - 1));
}
