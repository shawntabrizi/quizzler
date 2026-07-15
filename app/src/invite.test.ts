import { describe, expect, it } from "vitest";
import { consumeSharedLobbyInvite, sharedLobbyInviteUrl } from "./invite";

describe("shared lobby invite links", () => {
    it("accepts only a valid six-digit lobby code and consumes the query parameter", () => {
        expect(consumeSharedLobbyInvite("https://quizzler.example/play?theme=dark&join=466181#lobby"))
            .toEqual({
                present: true,
                gameId: 466181n,
                deploymentId: null,
                cleanedUrl: "https://quizzler.example/play?theme=dark#lobby",
            });
        expect(consumeSharedLobbyInvite("https://quizzler.example/play?join=12345").gameId).toBeNull();
        expect(consumeSharedLobbyInvite("https://quizzler.example/play").present).toBe(false);
    });

    it("builds an invite while preserving the rest of the product URL", () => {
        expect(sharedLobbyInviteUrl("https://quizzler.example/play?show-test-packs=1&theme=dark#lobby", 466181n))
            .toBe("https://quizzler.example/play?theme=dark&join=466181#lobby");
        expect(sharedLobbyInviteUrl("https://quizzler.example/play?theme=dark#lobby", 466181n, "paseo-july-2026"))
            .toBe("https://quizzler.example/play?theme=dark&join=466181&d=paseo-july-2026#lobby");
    });
});
