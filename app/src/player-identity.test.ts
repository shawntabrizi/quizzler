import { describe, expect, it } from "vitest";

import { generatedPlayerName, playerLabels, playerName } from "./player-identity";

const ALICE = "0x00112233445566778899aabbccddeeff00112233";
const BOB = "0xffeeddccbbaa99887766554433221100ffeeddcc";

describe("friendly player identities", () => {
    it("is stable across casing and never exposes an address", () => {
        const name = generatedPlayerName(ALICE);

        expect(generatedPlayerName(ALICE.toUpperCase())).toBe(name);
        expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ · [A-Z0-9]{13}$/);
        expect(name).not.toContain("0x");
        expect(name).not.toContain("001122");
    });

    it("uses an on-chain alias when one exists", () => {
        expect(playerName(ALICE, "Quiz Captain")).toBe("Quiz Captain");
        expect(playerName(ALICE, "   ")).toBe(generatedPlayerName(ALICE));
    });

    it("keeps duplicate chosen aliases understandable without addresses", () => {
        const labels = playerLabels([ALICE, BOB], ["Alex", "Alex"]);

        expect(labels).toHaveLength(2);
        expect(labels[0]).toMatch(/^Alex · [A-Z0-9]{13}$/);
        expect(labels[1]).toMatch(/^Alex · [A-Z0-9]{13}$/);
        expect(labels[0]).not.toBe(labels[1]);
        expect(labels.join(" ")).not.toContain("0x");
    });

    it("keeps unnamed players distinct and stable", () => {
        const labels = playerLabels([ALICE, BOB], []);

        expect(labels).toEqual([generatedPlayerName(ALICE), generatedPlayerName(BOB)]);
        expect(labels[0]).not.toBe(labels[1]);
    });
});
