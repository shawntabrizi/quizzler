/** Durable data needed to explain the final round without re-calculating it. */
export interface FinalSubmission {
    player: string;
    submitted: boolean;
    wager: number;
    correct: boolean;
    active: boolean;
}

export type FinalWagerOutcome = "won" | "lost" | "neutral";

export interface FinalStanding {
    player: string;
    score: number;
    /** A forfeited player remains visible but cannot receive a placement. */
    active: boolean;
    /** Competition rank: 1, 2, 2, 4 for tied scores; null after a forfeit. */
    placement: number | null;
    finalWager: number;
    finalSubmitted: boolean;
    finalCorrect: boolean;
    /** Applied final-round score change, not an inferred score total. */
    finalDelta: number;
    finalOutcome: FinalWagerOutcome;
}

export interface FinalStandingsInput {
    players: readonly string[];
    scores: readonly number[];
    finalWagers: readonly number[];
    submissions: readonly FinalSubmission[];
}

/**
 * Produce the settled scorecard in the same policy used by the game: active
 * players are ranked by final score, while people who forfeited stay visible
 * as historical rows without a competitive placement.
 */
export function rankFinalStandings(input: FinalStandingsInput): FinalStanding[] {
    const rows = input.players.map((player, index) => {
        const submission = input.submissions.find(
            (candidate) => candidate.player.toLowerCase() === player.toLowerCase(),
        );
        const finalSubmitted = submission?.submitted ?? false;
        const finalWager = finalSubmitted
            ? submission?.wager ?? 0
            : input.finalWagers[index] ?? 0;
        const finalCorrect = finalSubmitted && Boolean(submission?.correct);
        const finalOutcome: FinalWagerOutcome = !finalSubmitted || finalWager === 0
            ? "neutral"
            : finalCorrect
              ? "won"
              : "lost";
        return {
            player,
            score: input.scores[index] ?? 0,
            active: submission?.active ?? true,
            placement: null as number | null,
            finalWager,
            finalSubmitted,
            finalCorrect,
            finalDelta: !finalSubmitted || finalWager === 0
                ? 0
                : finalCorrect
                  ? finalWager
                  : -finalWager,
            finalOutcome,
            index,
        };
    });

    const active = rows
        .filter((row) => row.active)
        .sort((a, b) => b.score - a.score || a.index - b.index);
    let previousScore: number | null = null;
    let placement = 0;
    for (let index = 0; index < active.length; index += 1) {
        if (active[index].score !== previousScore) placement = index + 1;
        active[index].placement = placement;
        previousScore = active[index].score;
    }

    const inactive = rows.filter((row) => !row.active);
    return [...active, ...inactive].map(({ index: _index, ...row }) => row);
}

export const PLACEMENT_TROPHIES: Record<number, { emoji: string; label: string }> = {
    1: { emoji: "🥇", label: "First place" },
    2: { emoji: "🥈", label: "Second place" },
    3: { emoji: "🥉", label: "Third place" },
};

export function ordinal(value: number): string {
    const mod100 = value % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
    switch (value % 10) {
        case 1: return `${value}st`;
        case 2: return `${value}nd`;
        case 3: return `${value}rd`;
        default: return `${value}th`;
    }
}

export function placementText(standing: FinalStanding): string {
    if (standing.placement === null) return "Left quiz";
    const trophy = PLACEMENT_TROPHIES[standing.placement];
    return `${trophy ? `${trophy.emoji} ` : ""}${ordinal(standing.placement)} place`;
}

/**
 * Explain the final round in one phrase. A locked wager with no submission is
 * deliberately "not applied": the contract only settles a wager against an
 * actual final answer, and the copy must not imply points were lost.
 */
export function finalOutcomeText(standing: FinalStanding): string {
    if (!standing.finalSubmitted) {
        return standing.finalWager > 0
            ? `No final answer · ${standing.finalWager} locked, not applied`
            : "No final answer";
    }
    if (standing.finalWager === 0) {
        return standing.finalCorrect ? "Correct · no points wagered" : "Incorrect · no points wagered";
    }
    return standing.finalOutcome === "won" ? "Wager won" : "Wager lost";
}

export function finalWagerValue(standing: FinalStanding): string {
    if (!standing.finalSubmitted) {
        return standing.finalWager > 0 ? `${standing.finalWager} locked` : "0";
    }
    if (standing.finalWager === 0) return "0";
    return standing.finalDelta > 0 ? `+${standing.finalDelta}` : `−${Math.abs(standing.finalDelta)}`;
}
