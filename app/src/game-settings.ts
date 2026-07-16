import { presetLabel, type BlockPreset } from "./game-config";

const STAGE_LOBBY = 0;
const STAGE_ANSWER = 1;
const STAGE_REVIEW = 2;
const STAGE_VOTE = 3;
const STAGE_FINAL_WAGER = 4;
const STAGE_FINAL_ANSWER = 5;
const STAGE_FINAL_REVIEW = 6;

export function gamePaceLabel(blocks: number, presets: readonly BlockPreset[]): string {
    const preset = presets.find((candidate) => candidate.blocks === blocks);
    return preset ? presetLabel(preset) : "Custom pace";
}

export function gameProgressLabel(stage: number, cursor: number, questionCount: number): string {
    const question = Math.min(Math.max(cursor + 1, 1), Math.max(questionCount, 1));
    switch (stage) {
        case STAGE_LOBBY:
            return "Lobby · waiting to start";
        case STAGE_ANSWER:
            return `Question ${question} of ${questionCount}`;
        case STAGE_REVIEW:
            return `Reviewing question ${question} of ${questionCount}`;
        case STAGE_VOTE:
            return "Choosing the final question";
        case STAGE_FINAL_WAGER:
            return "Setting final wagers";
        case STAGE_FINAL_ANSWER:
            return "Final question";
        case STAGE_FINAL_REVIEW:
            return "Reviewing the final question";
        default:
            return "Quiz in progress";
    }
}

/** The review acknowledgement should explain the next distinct party step. */
export function reviewContinueLabel(stage: number, cursor: number, questionCount: number): string {
    if (stage === STAGE_FINAL_REVIEW) return "See final results";
    if (stage === STAGE_REVIEW && cursor + 1 >= questionCount) return "Choose final difficulty";
    return "Ready for next question";
}

export function questionCountLabel(questionCount: number): string {
    return `${questionCount} ${questionCount === 1 ? "question" : "questions"}`;
}

export function playerCountLabel(activePlayers: number, totalPlayers: number): string {
    const active = `${activePlayers} active ${activePlayers === 1 ? "player" : "players"}`;
    return totalPlayers === activePlayers
        ? active
        : `${active} of ${totalPlayers} total`;
}
