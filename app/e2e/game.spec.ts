import { expect, test } from "./fixtures";
import { ScriptedPlayer } from "./scripted-player";

/**
 * Full two-player game: bob plays through the UI, charlie is scripted
 * against the contract. Covers the whole loop — lobby, answer + wager,
 * live answers, review with an overturn vote, continue collapse, the
 * difficulty vote, the final wager round, and the results screen.
 *
 * Scoring walkthrough (charlie answers wrong on purpose, wagering 5):
 *   Q1: bob correct +7 → 7; charlie wrong 0, bob votes "mark correct" —
 *       with 2 players the single other player is a majority → charlie +5.
 *   Final (both vote easy → "what is 2 plus 2"): bob all-in 7 → 14,
 *       charlie wagers 0 → stays 5. Winner: bob at 14.
 */
test("plays a full two-player game to the results screen", async ({ testHost }) => {
    test.setTimeout(600_000);

    // Boot the UI player first — charlie's pack setup is slow, and the home
    // screen re-polls the pack list, so his pack appears once sealed.
    await testHost.waitForConnection();
    const frame = testHost.productFrame();
    await expect(frame.getByTestId("conn-pill")).toHaveText("connected", { timeout: 120_000 });

    const charlie = await ScriptedPlayer.connect("Charlie");
    try {
        const packTitle = `E2E Game ${Date.now()}`;
        const packId = await charlie.createTestPack(packTitle, {
            text: "What is the capital of Japan?",
            answers: ["Tokyo"],
        });

        // ── create the game from charlie's pack ──────────────────
        await frame.getByTestId("btn-host-game").click();
        await expect(frame.getByTestId("screen-pack-select")).toBeVisible();
        await expect(frame.getByTestId(`pack-${packId}`)).toBeVisible({ timeout: 60_000 });
        await frame.getByTestId(`pack-${packId}`).click();
        await frame.getByTestId("btn-pack-continue").click();
        await expect(frame.getByTestId("screen-configure")).toBeVisible();
        await frame.getByTestId("cfg-questions").selectOption("1");
        await frame.getByTestId("cfg-answer-blocks").selectOption("45");
        await frame.getByTestId("cfg-review-blocks").selectOption("30");
        await frame.getByTestId("btn-create-game").click();

        await expect(frame.getByTestId("screen-lobby")).toBeVisible({ timeout: 120_000 });
        const gameId = BigInt((await frame.getByTestId("lobby-game-id").textContent()) ?? "");

        // ── charlie joins, bob starts ────────────────────────────
        await charlie.tx("joinGame", [gameId]);
        await expect(frame.getByTestId("lobby-players").locator("li")).toHaveCount(2, {
            timeout: 60_000,
        });
        await frame.getByTestId("btn-start-game").click();

        // charlie plays the rest of the game on a poll loop
        const charlieDone = charlie.playUntilFinished(gameId, {
            answer: "wrong on purpose",
            wager: 5,
            finalWager: 0,
            difficultyVote: 0,
        });

        // ── question 1: bob answers correctly with wager 7 ───────
        await expect(frame.getByTestId("screen-question")).toBeVisible({ timeout: 120_000 });
        await expect(frame.getByTestId("question-text")).toHaveText("What is the capital of Japan?");
        await frame.getByTestId("answer-input").fill("Tokyo");
        await frame.getByTestId("wager-7").click();
        await frame.getByTestId("btn-submit-answer").click();

        // After submitting, bob either sees the live answers card (charlie
        // still thinking) or — if his was the last submission — the phase
        // collapses straight into review. (Not `.or()`: both nodes are always
        // in the DOM, which trips strict mode.)
        await expect(async () => {
            const card = await frame.getByTestId("submitted-card").isVisible();
            const review = await frame.getByTestId("screen-review").isVisible();
            expect(card || review).toBe(true);
        }).toPass({ timeout: 60_000 });

        // ── review: bob is right, charlie is wrong; bob overturns ─
        await expect(frame.getByTestId("screen-review")).toBeVisible({ timeout: 120_000 });
        await expect(frame.getByTestId("review-answer")).toHaveText("tokyo");
        const voteBtn = frame.getByTestId(`btn-vote-${charlie.h160}`);
        await expect(voteBtn).toBeVisible();
        await voteBtn.click();
        // 2 players → 1 vote is a majority of the others; charlie's answer
        // flips to correct and the vote button disappears from his row
        await expect(voteBtn).toBeHidden({ timeout: 60_000 });
        await expect(frame.getByTestId("review-rows").locator(".wager-badge.correct")).toHaveCount(2, {
            timeout: 60_000,
        });
        const scoreBadge = frame.getByTestId("review-rows").locator(".wager-badge").first();
        await expect(scoreBadge).toBeVisible();
        await expect(scoreBadge).toHaveCSS("width", "34px");
        await expect(scoreBadge).toHaveCSS("height", "34px");
        await frame.getByTestId("btn-continue").click();

        // ── difficulty vote (both pick easy) ─────────────────────
        await expect(frame.getByTestId("screen-vote")).toBeVisible({ timeout: 120_000 });
        await frame.getByTestId("btn-difficulty-easy").click();

        // ── final question: bob goes all-in ──────────────────────
        await expect(frame.getByTestId("screen-question")).toBeVisible({ timeout: 120_000 });
        await expect(frame.getByTestId("question-number")).toContainText("Final");
        await frame.getByTestId("answer-input").fill("4");
        await frame.getByTestId("wager-final").fill("7");
        await frame.getByTestId("btn-submit-answer").click();

        // ── final review → results ───────────────────────────────
        await expect(frame.getByTestId("screen-review")).toBeVisible({ timeout: 120_000 });
        await frame.getByTestId("btn-continue").click();

        await expect(frame.getByTestId("screen-results")).toBeVisible({ timeout: 180_000 });
        await expect(frame.getByTestId("results-winner")).toHaveText("You");
        await expect(frame.getByTestId("results-leaderboard").getByText("14")).toBeVisible();

        await charlieDone;
        const scores = await charlie.query<(number | bigint)[]>("getScores", [gameId]);
        expect(scores.map(Number).sort((a, b) => b - a)).toEqual([14, 5]);
    } finally {
        charlie.destroy();
    }
});
