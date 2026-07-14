import { describe, expect, it } from "vitest";
import { isE2ETestPack, packPresentation, sectionPacks } from "./pack-presentation";

describe("pack presentation", () => {
    it("recognizes only the deterministic E2E pack namespace", () => {
        expect(isE2ETestPack("E2E Builder 1783973078971")).toBe(true);
        expect(isE2ETestPack("E2E Game 1783973033300")).toBe(true);
        expect(isE2ETestPack("E2E Game night")).toBe(false);
        expect(isE2ETestPack("Friday night trivia")).toBe(false);
    });

    it("uses the immutable registry emoji for a featured starter pack", () => {
        expect(packPresentation({
            id: 1,
            title: "Movies & TV",
            emoji: "🍿",
            regular_count: 200,
        })).toMatchObject({
            emoji: "🍿",
            category: "Screen",
            featuredOrder: 1,
        });
    });

    it("does not promote a later same-titled community pack", () => {
        expect(packPresentation({
            id: 42,
            title: "Music",
            emoji: "🎸",
            regular_count: 10,
        })).toMatchObject({
            emoji: "🎸",
            category: "Community",
        });
    });

    it("puts verified starters in catalog order and hides E2E packs by default", () => {
        const packs = [
            { id: 19, title: "E2E Game 1783973033300", emoji: "🧪", regular_count: 1 },
            { id: 7, title: "Food & Drink", emoji: "🍜", regular_count: 200 },
            { id: 0, title: "General Knowledge", emoji: "🧠", regular_count: 200 },
            { id: 44, title: "Friday Night", emoji: "🥳", regular_count: 8 },
            { id: 43, title: "Sunday Quiz", emoji: "☀️", regular_count: 5 },
        ];

        expect(sectionPacks(packs, "", false)).toEqual({
            featured: [packs[2], packs[1]],
            community: [packs[3], packs[4]],
        });
        expect(sectionPacks(packs, "", true).community.map((pack) => pack.id)).toEqual([44, 43, 19]);
    });

    it("filters both catalog sections by title", () => {
        const packs = [
            { id: 0, title: "General Knowledge", emoji: "🧠", regular_count: 200 },
            { id: 44, title: "Friday Night", emoji: "🥳", regular_count: 8 },
        ];
        expect(sectionPacks(packs, "night", false)).toEqual({ featured: [], community: [packs[1]] });
    });
});
