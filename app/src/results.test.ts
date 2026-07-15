import { describe, expect, it } from "vitest";

import { rankFinalStandings } from "./results";

describe("final result scorecards", () => {
    it("explains won, lost, and unsubmitted final wagers correctly", () => {
        const standings = rankFinalStandings({
            players: ["alice", "bob", "charlie"],
            scores: [12, 4, 7],
            finalWagers: [3, 4, 5],
            submissions: [
                { player: "alice", submitted: true, wager: 3, correct: true, active: true },
                { player: "bob", submitted: true, wager: 4, correct: false, active: true },
                { player: "charlie", submitted: false, wager: 0, correct: false, active: true },
            ],
        });

        expect(standings.map(({ finalOutcome, finalDelta, finalWager }) => ({
            finalOutcome,
            finalDelta,
            finalWager,
        }))).toEqual([
            { finalOutcome: "won", finalDelta: 3, finalWager: 3 },
            { finalOutcome: "neutral", finalDelta: 0, finalWager: 5 },
            { finalOutcome: "lost", finalDelta: -4, finalWager: 4 },
        ]);
    });

    it("assigns fair tied placements and keeps forfeited players visible", () => {
        const standings = rankFinalStandings({
            players: ["alice", "bob", "charlie", "dana"],
            scores: [10, 8, 8, 99],
            finalWagers: [0, 0, 0, 0],
            submissions: [
                { player: "alice", submitted: true, wager: 0, correct: true, active: true },
                { player: "bob", submitted: true, wager: 0, correct: true, active: true },
                { player: "charlie", submitted: true, wager: 0, correct: true, active: true },
                { player: "dana", submitted: false, wager: 0, correct: false, active: false },
            ],
        });

        expect(standings.map(({ player, placement, active }) => ({ player, placement, active }))).toEqual([
            { player: "alice", placement: 1, active: true },
            { player: "bob", placement: 2, active: true },
            { player: "charlie", placement: 2, active: true },
            { player: "dana", placement: null, active: false },
        ]);
    });
});
