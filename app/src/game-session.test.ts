import { describe, expect, it } from "vitest";

import { activeGameSessionKey, parseStoredGameId } from "./game-session";

describe("active game browser session", () => {
    it("scopes a remembered room to the chain contract and account", () => {
        const key = activeGameSessionKey(
            "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD",
            "0x0123456789ABCDEF0123456789ABCDEF01234567",
        );
        expect(key).toBe(
            "quizzler.active-game.v1:paseo-asset-hub:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:0x0123456789abcdef0123456789abcdef01234567",
        );
    });

    it("only restores valid six-digit contract game codes", () => {
        expect(parseStoredGameId("123456")).toBe(123456n);
        expect(parseStoredGameId(null)).toBeNull();
        expect(parseStoredGameId("12345")).toBeNull();
        expect(parseStoredGameId("not-a-game")).toBeNull();
    });
});
