import { describe, expect, it } from "vitest";

import {
    automaticInstantPlayAllowed,
    normalizeInstantPlayPreference,
    temporaryInstantPlayFailure,
} from "./instant-play-preference";

describe("instant play preference", () => {
    it("defaults to automatic setup when no preference is saved", () => {
        expect(automaticInstantPlayAllowed(null, 100)).toBe(true);
    });

    it("keeps an explicit wallet-signing choice until the player retries", () => {
        expect(automaticInstantPlayAllowed({ mode: "manual" }, 100)).toBe(false);
    });

    it("temporarily defers a failed automatic attempt", () => {
        const preference = temporaryInstantPlayFailure(100);
        expect(automaticInstantPlayAllowed(preference, 101)).toBe(false);
        expect(automaticInstantPlayAllowed(preference, preference.retryAfter)).toBe(true);
    });

    it("ignores malformed persisted data", () => {
        expect(normalizeInstantPlayPreference({ mode: "other", retryAfter: -1 })).toBeNull();
        expect(normalizeInstantPlayPreference({ mode: "manual" })).toEqual({ mode: "manual" });
    });
});
