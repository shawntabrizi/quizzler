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
