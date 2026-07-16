import { describe, expect, it } from "vitest";
import { isE2ETestPack, packPresentation } from "./pack-presentation";

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

});
