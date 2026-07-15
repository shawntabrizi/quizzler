import { describe, expect, it } from "vitest";

import {
    finalOutcomeText,
    finalWagerValue,
    ordinal,
    placementText,
    rankFinalStandings,
    type FinalStanding,
} from "./results";

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

function standing(overrides: Partial<FinalStanding>): FinalStanding {
    return {
        player: "alice",
        score: 5,
        active: true,
        placement: 1,
        finalWager: 0,
        finalSubmitted: true,
        finalCorrect: false,
        finalDelta: 0,
        finalOutcome: "neutral",
        ...overrides,
    };
}

describe("final result copy", () => {
    it("uses English ordinal suffixes including the 11th–13th exceptions", () => {
        expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 111].map(ordinal)).toEqual(
            ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "111th"],
        );
    });

    it("never awards a placement to a forfeited player", () => {
        expect(placementText(standing({ placement: null }))).toBe("Left quiz");
        expect(placementText(standing({ placement: 1 }))).toBe("🥇 1st place");
        expect(placementText(standing({ placement: 4 }))).toBe("4th place");
    });

    it("says a locked-but-unanswered wager was not applied", () => {
        // The contract only settles a wager against an actual final answer;
        // the copy must not imply points were lost.
        const skipped = standing({ finalSubmitted: false, finalWager: 4 });
        expect(finalOutcomeText(skipped)).toBe("No final answer · 4 locked, not applied");
        expect(finalWagerValue(skipped)).toBe("4 locked");
    });

    it("signs settled wagers by their applied score change", () => {
        expect(finalWagerValue(standing({ finalWager: 3, finalDelta: 3, finalOutcome: "won" }))).toBe("+3");
        expect(finalWagerValue(standing({ finalWager: 3, finalDelta: -3, finalOutcome: "lost" }))).toBe("−3");
        expect(finalOutcomeText(standing({ finalWager: 3, finalOutcome: "won" }))).toBe("Wager won");
        expect(finalOutcomeText(standing({ finalWager: 0, finalCorrect: true }))).toBe("Correct · no points wagered");
    });
});
