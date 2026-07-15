import { expect, test } from "./fixtures";
import { ScriptedPlayer } from "./scripted-player";

test("opens a shared invite directly into its lobby", async ({ testHost }) => {
    test.setTimeout(300_000);
    await testHost.waitForConnection();

    const charlie = await ScriptedPlayer.connect("Charlie");
    try {
        const packId = await charlie.createTestPack(`E2E Invite ${Date.now()}`, {
            text: "Which planet is known as the Red Planet?",
            answers: ["Mars"],
        });
        const gameId = await charlie.createTestGame(packId, 1, 600, 600, 2);

        // The host forwards its own query string to the product iframe.
        // Reloading the host this way also gives the new app instance a fresh
        // session, exactly like someone opening an invite in a new browser.
        const invitePage = new URL(testHost.page.url());
        invitePage.searchParams.set("show-test-packs", "1");
        invitePage.searchParams.set("join", gameId.toString());
        await testHost.page.goto(invitePage.toString());
        await testHost.waitForConnection();
        const frame = testHost.productFrame();

        await expect(frame.getByTestId("conn-pill")).toHaveText("connected", { timeout: 120_000 });
        await expect(frame.getByTestId("screen-lobby")).toBeVisible({ timeout: 120_000 });
        await expect(frame.getByTestId("lobby-game-id")).toHaveText(String(gameId));
        await expect(frame.getByTestId("lobby-game-id")).toHaveText(/^\d{6}$/);
        await expect(frame.getByTestId("lobby-players").locator("li")).toHaveCount(2, { timeout: 60_000 });
        await expect(frame.getByTestId("btn-share-lobby")).toBeVisible();
    } finally {
        charlie.destroy();
    }
});
