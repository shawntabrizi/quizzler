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
        const gameId = await charlie.createTestGame(packId, 1, 600, 600, 2);

        await frame.getByTestId("join-game-id").fill(String(gameId));
        await frame.getByTestId("btn-join-game").click();
        await expect(frame.getByTestId("screen-lobby")).toBeVisible({ timeout: 120_000 });

        await charlie.tx("startGame", [gameId]);
        await expect(frame.getByTestId("screen-question")).toBeVisible({ timeout: 120_000 });
        await expect(frame.getByTestId("question-text")).toHaveText("What is the capital of Portugal?");

        // Settings must be a stable detour: a passive poll cannot kick the
        // player out, and returning must retain their in-progress answer.
        await frame.getByTestId("answer-input").fill("Lisbon");
        await frame.getByTestId("wager-1").click();
        await frame.getByTestId("btn-game-settings").click();
        await expect(frame.getByTestId("screen-game-settings")).toBeVisible();
        await expect(frame.getByTestId("settings-game-code")).toHaveText(String(gameId));
        await expect(frame.getByTestId("game-stage-timer")).toBeHidden();
        // Let at least one passive refresh land while settings is open; it
        // must remain a stable detour rather than reopening the question.
        await testHost.page.waitForTimeout(2_500);
        await expect(frame.getByTestId("screen-game-settings")).toBeVisible();
        await frame.getByTestId("btn-settings-return").click();
        await expect(frame.getByTestId("screen-question")).toBeVisible();
        await expect(frame.getByTestId("answer-input")).toHaveValue("Lisbon");
        await expect(frame.getByTestId("wager-1")).toHaveAttribute("aria-pressed", "true");

        // A visible recovery row is available after an intentional detour to
        // Home; reopening it is a read-only return, not another join call.
        await frame.getByTestId("btn-game-settings").click();
        await frame.getByTestId("btn-settings-back-home").click();
        await expect(frame.getByTestId("screen-home")).toBeVisible();
        await expect(frame.getByTestId("your-games")).toBeVisible();
        const rejoin = frame.locator(`[data-testid="btn-rejoin-game"][data-game-id="${gameId}"]`);
        await expect(rejoin).toBeEnabled({ timeout: 120_000 });
        await rejoin.click();
        await expect(frame.getByTestId("screen-question")).toBeVisible({ timeout: 120_000 });

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
