import { expect, test } from "./fixtures";
import { ScriptedPlayer } from "./scripted-player";

const STAGE = { ANSWER: 1, REVIEW: 2, ABANDONED: 7 } as const;

test("transfers the lobby starter and excludes forfeits from later quorums", async () => {
    test.setTimeout(600_000);
    const charlie = await ScriptedPlayer.connect("Charlie");
    const bob = await ScriptedPlayer.connect("Bob");
    try {
        const packId = await charlie.createTestPack(`E2E Lifecycle ${Date.now()}`, {
            text: "What is the capital of Japan?",
            answers: ["Tokyo"],
        });

        // Leaving the lobby removes the current starter, so the oldest
        // remaining player can start without becoming a permanent host.
        const handoffGame = await charlie.createTestGame(packId, 1, 600, 600, 4);
        await bob.tx("joinGame", [handoffGame]);
        await charlie.tx("leaveLobby", [handoffGame]);
        expect((await bob.query<string[]>("getPlayers", [handoffGame])).map((p) => p.toLowerCase())).toEqual([bob.h160]);
        await bob.tx("startGame", [handoffGame]);
        expect((await bob.getPhase(handoffGame)).stage).toBe(STAGE.ANSWER);

        // In a separate two-player room, Charlie's answer is historical after
        // he forfeits; it must not satisfy Bob's remaining one-player quorum.
        const gameId = await charlie.createTestGame(packId, 1, 600, 600, 4);
        await bob.tx("joinGame", [gameId]);
        await charlie.tx("startGame", [gameId]);
        await charlie.tx("submitAnswer", [gameId, "Tokyo", 1]);
        await charlie.tx("forfeitGame", [gameId]);

        let phase = await bob.getPhase(gameId);
        expect(phase.stage).toBe(STAGE.ANSWER);
        expect(phase.player_count).toBe(2);
        expect(phase.active_player_count).toBe(1);
        expect(phase.submit_count).toBe(0);
        expect(await bob.query<boolean>("isPlayerActive", [gameId, charlie.h160])).toBe(false);
        expect(await bob.query<boolean>("isPlayerActive", [gameId, bob.h160])).toBe(true);
        expect(await bob.query<string[]>("getPlayers", [gameId])).toHaveLength(2);

        // Bob's own answer is now needed to advance; Charlie's earlier answer
        // cannot advance the stage on Bob's behalf.
        await bob.tx("submitAnswer", [gameId, "Tokyo", 2]);
        phase = await bob.getPhase(gameId);
        expect(phase.stage).toBe(STAGE.REVIEW);
        expect(phase.active_player_count).toBe(1);

        // Last active player leaving is explicit abandonment, not a normal
        // scored finish.
        await bob.tx("forfeitGame", [gameId]);
        phase = await bob.getPhase(gameId);
        expect(phase.stage).toBe(STAGE.ABANDONED);
        expect(phase.active_player_count).toBe(0);
    } finally {
        charlie.destroy();
        bob.destroy();
    }
});
