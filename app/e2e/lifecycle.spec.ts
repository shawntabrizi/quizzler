import { expect, test } from "./fixtures";
import { ScriptedPlayer } from "./scripted-player";

const STAGE = { ANSWER: 1, REVIEW: 2, ABANDONED: 7 } as const;

test("transfers the lobby starter and excludes forfeits from later quorums", async () => {
    test.setTimeout(600_000);
    const charlie = await ScriptedPlayer.connect("Charlie");
    const alice = await ScriptedPlayer.connect("Alice");
    const dave = await ScriptedPlayer.connect("Dave");
    try {
        const packId = await charlie.createTestPack(`E2E Lifecycle ${Date.now()}`, {
            text: "What is the capital of Japan?",
            answers: ["Tokyo"],
        });

        // Leaving the lobby removes the current starter, so the oldest
        // remaining player can start without becoming a permanent host.
        await charlie.tx("createGame", [packId, 1, 600, 600, 4]);
        const handoffGame = BigInt(await charlie.query<number | bigint>("myLatestGame", [charlie.h160]));
        await alice.tx("joinGame", [handoffGame]);
        await charlie.tx("leaveLobby", [handoffGame]);
        expect(await alice.query<string[]>("getPlayers", [handoffGame])).toEqual([alice.h160]);
        await alice.tx("startGame", [handoffGame]);
        expect((await alice.getPhase(handoffGame)).stage).toBe(STAGE.ANSWER);

        // In a separate three-player room, Charlie's answer is historical
        // after he forfeits; it must not count as Alice/Dave's future quorum.
        await charlie.tx("createGame", [packId, 1, 600, 600, 4]);
        const gameId = BigInt(await charlie.query<number | bigint>("myLatestGame", [charlie.h160]));
        await alice.tx("joinGame", [gameId]);
        await dave.tx("joinGame", [gameId]);
        await charlie.tx("startGame", [gameId]);
        await charlie.tx("submitAnswer", [gameId, "Tokyo", 1]);
        await charlie.tx("forfeitGame", [gameId]);
        await alice.tx("submitAnswer", [gameId, "Tokyo", 2]);

        let phase = await alice.getPhase(gameId);
        expect(phase.stage).toBe(STAGE.ANSWER);
        expect(phase.player_count).toBe(3);
        expect(phase.active_player_count).toBe(2);
        expect(phase.submit_count).toBe(1);
        expect(await alice.query<boolean>("isPlayerActive", [gameId, charlie.h160])).toBe(false);
        expect(await alice.query<boolean>("isPlayerActive", [gameId, alice.h160])).toBe(true);
        expect(await alice.query<string[]>("getPlayers", [gameId])).toHaveLength(3);

        // Once Dave forfeits too, Alice is the only active participant and
        // her already-submitted answer immediately advances the round.
        await dave.tx("forfeitGame", [gameId]);
        phase = await alice.getPhase(gameId);
        expect(phase.stage).toBe(STAGE.REVIEW);
        expect(phase.active_player_count).toBe(1);

        // Last active player leaving is explicit abandonment, not a normal
        // scored finish.
        await alice.tx("forfeitGame", [gameId]);
        phase = await alice.getPhase(gameId);
        expect(phase.stage).toBe(STAGE.ABANDONED);
        expect(phase.active_player_count).toBe(0);
    } finally {
        charlie.destroy();
        alice.destroy();
        dave.destroy();
    }
});
