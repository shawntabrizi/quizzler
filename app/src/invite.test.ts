import { describe, expect, it } from "vitest";
import { consumeSharedLobbyInvite, sharedLobbyInviteUrl } from "./invite";

describe("shared lobby invite links", () => {
    it("accepts only a valid six-digit lobby code and consumes the query parameter", () => {
        expect(consumeSharedLobbyInvite("https://quizzler.example/play?theme=dark&join=466181#lobby"))
            .toEqual({
                present: true,
                gameId: 466181n,
                cleanedUrl: "https://quizzler.example/play?theme=dark#lobby",
            });
        expect(consumeSharedLobbyInvite("https://quizzler.example/play?join=12345").gameId).toBeNull();
        expect(consumeSharedLobbyInvite("https://quizzler.example/play").present).toBe(false);
        expect(consumeSharedLobbyInvite("polkadot://quizzler.dot/?join=466181#lobby"))
            .toEqual({
                present: true,
                gameId: 466181n,
                cleanedUrl: "polkadot://quizzler.dot/#lobby",
            });
    });

    it("builds a native .dot invite while preserving the product route", () => {
        expect(sharedLobbyInviteUrl("https://quizzler.example/play?show-test-packs=1&theme=dark#lobby", 466181n))
            .toBe("polkadot://quizzler.dot/play?theme=dark&join=466181#lobby");
        expect(sharedLobbyInviteUrl("https://quizzler.example/play?theme=dark&d=old-deployment#lobby", 466181n))
            .toBe("polkadot://quizzler.dot/play?theme=dark&join=466181#lobby");
    });
});
