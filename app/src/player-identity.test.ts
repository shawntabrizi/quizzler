import { describe, expect, it } from "vitest";

import { generatedPlayerName, playerLabels, playerName } from "./player-identity";

const ALICE = "0x00112233445566778899aabbccddeeff00112233";
const BOB = "0xffeeddccbbaa99887766554433221100ffeeddcc";

describe("friendly player identities", () => {
    it("is stable across casing and never exposes an address", () => {
        const name = generatedPlayerName(ALICE);

        expect(generatedPlayerName(ALICE.toUpperCase())).toBe(name);
        expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
        expect(name).not.toContain("0x");
        expect(name).not.toContain("001122");
        expect(name).not.toMatch(/[·\d]/u);
    });

    it("uses an on-chain alias when one exists", () => {
        expect(playerName(ALICE, "Quiz Captain")).toBe("Quiz Captain");
        expect(playerName(ALICE, "   ")).toBe(generatedPlayerName(ALICE));
    });

    it("keeps duplicate chosen names exactly as players chose them", () => {
        const labels = playerLabels([ALICE, BOB], ["Alex", "Alex"]);

        expect(labels).toEqual(["Alex", "Alex"]);
    });

    it("keeps unnamed players distinct and stable", () => {
        const labels = playerLabels([ALICE, BOB], []);

        expect(labels).toEqual([generatedPlayerName(ALICE), generatedPlayerName(BOB)]);
        expect(labels[0]).not.toBe(labels[1]);
    });
});
