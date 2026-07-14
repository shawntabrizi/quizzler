import { expect, test } from "./fixtures";
import { ScriptedPlayer } from "./scripted-player";

/**
 * A guest (rather than the creator) joins a live room, refreshes the host
 * page, and returns to the same question without signing another join call.
 */
test("reopens an active joined quiz after refresh", async ({ testHost }) => {
    test.setTimeout(420_000);
    await testHost.waitForConnection();
    let frame = testHost.productFrame();
    await expect(frame.getByTestId("conn-pill")).toHaveText("connected", { timeout: 120_000 });

    const charlie = await ScriptedPlayer.connect("Charlie");
    try {
        const packId = await charlie.createTestPack(`E2E Rejoin ${Date.now()}`, {
            text: "What is the capital of Portugal?",
            answers: ["Lisbon"],
        });
        await charlie.tx("createGame", [packId, 1, 600, 600, 2]);
        const gameId = BigInt(await charlie.query<number | bigint>("myLatestGame", [charlie.h160]));

        await frame.getByTestId("join-game-id").fill(String(gameId));
        await frame.getByTestId("btn-join-game").click();
        await expect(frame.getByTestId("screen-lobby")).toBeVisible({ timeout: 120_000 });

        await charlie.tx("startGame", [gameId]);
        await expect(frame.getByTestId("screen-question")).toBeVisible({ timeout: 120_000 });
        await expect(frame.getByTestId("question-text")).toHaveText("What is the capital of Portugal?");

        // The host page owns the product iframe, so both must be reacquired
        // after reload. No UI signing follows this point: only chain reads are
        // valid evidence of a true rejoin.
        await testHost.page.reload();
        await testHost.waitForConnection();
        frame = testHost.productFrame();
        await expect(frame.getByTestId("conn-pill")).toHaveText("connected", { timeout: 120_000 });
        await expect(frame.getByTestId("screen-question")).toBeVisible({ timeout: 120_000 });
        await expect(frame.getByTestId("question-text")).toHaveText("What is the capital of Portugal?");
        await expect(frame.getByTestId("answer-form")).toBeVisible();
    } finally {
        charlie.destroy();
    }
});
