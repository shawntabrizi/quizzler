import { describe, expect, it } from "vitest";

import { appendUniquePacks, buildPackLibrarySections, visibleLibraryPacks } from "./pack-library";

const picks = [
    { id: 0, title: "General Knowledge", emoji: "🧠" },
    { id: 1, title: "Movies & TV", emoji: "🎬" },
];

describe("pack library", () => {
    it("hides empty personal and social rails without hiding a one-pack rail", () => {
        expect(buildPackLibrarySections({
            picks,
            favorites: [],
            popular: [{ id: 44, title: "Friday quiz", emoji: "✨" }],
            newest: [],
            includeE2ETestPacks: false,
        })).toEqual([
            { id: "picks", title: "Quizzler picks", packs: picks },
            {
                id: "popular",
                title: "Popular",
                packs: [{ id: 44, title: "Friday quiz", emoji: "✨" }],
            },
        ]);
    });

    it("preserves the ordering returned by contract-backed rails", () => {
        const popular = [
            { id: 30, title: "First", emoji: "🥇" },
            { id: 12, title: "Second", emoji: "🥈" },
        ];
        const sections = buildPackLibrarySections({
            picks: [], favorites: [], popular, newest: [], includeE2ETestPacks: false,
        });
        expect(sections[0].packs).toEqual(popular);
    });

    it("filters test packs consistently and only searches packs the client loaded", () => {
        const packs = [
            { id: 4, title: "Night trivia", emoji: "🌙" },
            { id: 5, title: "E2E Game 1783973033300", emoji: "🧪" },
        ];
        expect(visibleLibraryPacks(packs, "night", false)).toEqual([packs[0]]);
        expect(visibleLibraryPacks(packs, "", false)).toEqual([packs[0]]);
    });

    it("keeps saved order and hides a rail whose only result is non-player test data", () => {
        const favorite = { id: 22, title: "Second saved", emoji: "⭐" };
        const olderFavorite = { id: 18, title: "First saved", emoji: "💫" };
        const e2e = { id: 90, title: "E2E Builder 1783973078971", emoji: "🧪" };
        const sections = buildPackLibrarySections({
            picks: [],
            favorites: [favorite, olderFavorite],
            popular: [e2e],
            newest: [],
            includeE2ETestPacks: false,
        });

        expect(sections).toEqual([
            { id: "favorites", title: "Your favorites", packs: [favorite, olderFavorite] },
        ]);
    });

    it("matches loaded titles case-insensitively and removes duplicate ids within a rail", () => {
        const matching = { id: 8, title: "Late Night Geography", emoji: "🌍" };
        expect(visibleLibraryPacks([
            matching,
            { ...matching, title: "Duplicate should not appear" },
            { id: 9, title: "Movies", emoji: "🎬" },
        ], "  NIGHT  ", false)).toEqual([matching]);
    });

    it("appends a page once even when a cursor response overlaps a cached page", () => {
        const existing = [picks[0]];
        expect(appendUniquePacks(existing, [picks[0], picks[1], picks[1]])).toEqual(picks);
    });
});
