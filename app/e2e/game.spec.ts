import { expect, test } from "./fixtures";
import { ScriptedPlayer } from "./scripted-player";

/**
 * Full two-player game: bob plays through the UI, charlie is scripted
 * against the contract. Covers the whole loop — lobby, answer + wager,
 * live answers, review with an overturn vote, continue collapse, the
 * difficulty vote, the final wager round, and the results preview.
 *
 * Scoring walkthrough (charlie answers wrong on purpose, both wager 1):
 *   Q1: bob correct +1 → 1; charlie wrong 0, bob votes "mark correct" —
 *       with 2 players the single other player is a majority → charlie +1.
 *   Final (both vote easy → "what is 2 plus 2"): bob wagers 1 → 2,
 *       charlie wagers 1 and misses → 0. Winner: bob at 2.
 */
test("plays a full two-player game to the final-results preview", async ({ testHost }) => {
    test.setTimeout(600_000);

    // Boot the UI player first — charlie's pack setup is slow, and the home
    // screen re-polls the pack list, so his pack appears once sealed.
    await testHost.waitForConnection();
    const frame = testHost.productFrame();
    await expect(frame.getByTestId("conn-pill")).toHaveText("connected", { timeout: 120_000 });

    const charlie = await ScriptedPlayer.connect("Charlie");
    let releaseCharlieDifficultyVote: (() => void) | undefined;
    const charlieDifficultyVoteGate = new Promise<void>((resolve) => {
        releaseCharlieDifficultyVote = resolve;
    });
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
        const questionChoice = frame.getByTestId("cfg-questions-option-1");
        const answerChoice = frame.getByTestId("cfg-answer-blocks-option-45");
        const reviewChoice = frame.getByTestId("cfg-review-blocks-option-30");
        await questionChoice.click();
        await answerChoice.click();
        await reviewChoice.click();
        await expect(questionChoice.locator("input")).toBeChecked();
        await expect(answerChoice.locator("input")).toBeChecked();
        await expect(reviewChoice.locator("input")).toBeChecked();
        await frame.getByTestId("btn-create-game").click();

        await expect(frame.getByTestId("screen-lobby")).toBeVisible({ timeout: 120_000 });
        const gameId = BigInt((await frame.getByTestId("lobby-game-id").textContent()) ?? "");
        const createdGame = await charlie.query<{
            num_questions: number | bigint;
            answer_blocks: number | bigint;
            review_blocks: number | bigint;
        }>("getGame", [gameId]);
        expect(Number(createdGame.num_questions)).toBe(1);
        expect(Number(createdGame.answer_blocks)).toBe(45);
        expect(Number(createdGame.review_blocks)).toBe(30);

        // ── charlie joins, bob starts ────────────────────────────
        await charlie.tx("joinGame", [gameId]);
        await expect(frame.getByTestId("lobby-players").locator("li")).toHaveCount(2, {
            timeout: 60_000,
        });
        await frame.getByTestId("btn-start-game").click();

        // charlie plays the rest of the game on a poll loop
        const charlieDone = charlie.playUntilFinished(gameId, {
            answer: "wrong on purpose",
            wager: 1,
            finalWager: 1,
            difficultyVote: 0,
            beforeDifficultyVote: () => charlieDifficultyVoteGate,
            stopAtFinalReview: true,
        });

        // ── question 1: bob answers correctly with wager 1 ───────
        await expect(frame.getByTestId("screen-question")).toBeVisible({ timeout: 120_000 });
        await expect(frame.getByTestId("question-text")).toHaveText("What is the capital of Japan?");
        await frame.getByTestId("answer-input").fill("Tokyo");
        await frame.getByTestId("wager-1").click();
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
        // Hold Charlie just long enough to prove the on-chain live tally
        // reports Bob's Easy vote before the phase can collapse.
        await expect(frame.getByTestId("screen-vote")).toBeVisible({ timeout: 120_000 });
        await frame.getByTestId("btn-difficulty-easy").click();
        await expect.poll(async () => {
            const phase = await charlie.getPhase(gameId);
            return Number(phase.easy_vote_count);
        }, { timeout: 60_000 }).toBe(1);
        const votePhase = await charlie.getPhase(gameId);
        expect(Number(votePhase.stage)).toBe(3);
        expect(Number(votePhase.medium_vote_count)).toBe(0);
        expect(Number(votePhase.hard_vote_count)).toBe(0);
        await expect(frame.getByTestId("vote-distribution-easy-count")).toHaveText("1", {
            timeout: 60_000,
        });
        await expect(frame.getByTestId("vote-distribution-medium-count")).toHaveText("0");
        await expect(frame.getByTestId("vote-distribution-hard-count")).toHaveText("0");
        releaseCharlieDifficultyVote?.();

        // ── final wager: the final question stays hidden until it is locked
        await expect(frame.getByTestId("screen-final-wager")).toBeVisible({ timeout: 120_000 });
        await expect(frame.getByTestId("screen-question")).toBeHidden();
        await expect.poll(async () => {
            const phase = await charlie.getPhase(gameId);
            return [Number(phase.stage), Number(phase.final_wager_count)];
        }, { timeout: 60_000 }).toEqual([4, 1]);
        await expect(frame.getByTestId("final-wager-score")).toContainText("1");
        await expect(frame.getByTestId("final-wager-status")).toContainText("1/2 active players locked in", {
            timeout: 60_000,
        });
        await frame.getByTestId("final-wager-input").fill("1");
        await frame.getByTestId("btn-confirm-final-wager").click();

        // ── final question: Bob answers after his wager is locked ─
        await expect(frame.getByTestId("screen-question")).toBeVisible({ timeout: 120_000 });
        await expect(frame.getByTestId("question-number")).toContainText("Final");
        await frame.getByTestId("answer-input").fill("4");
        await frame.getByTestId("btn-submit-answer").click();

        // ── final review → results preview ───────────────────────
        await expect(frame.getByTestId("screen-review")).toBeVisible({ timeout: 120_000 });
        await expect(frame.getByTestId("btn-continue")).toBeHidden();
        await expect(frame.getByTestId("continue-status")).toBeHidden();
        await frame.getByTestId("btn-view-final-results").click();

        await expect(frame.getByTestId("screen-results")).toBeVisible({ timeout: 60_000 });
        await expect(frame.getByTestId("results-winner")).toHaveText("You");
        await expect(frame.getByTestId("results-final-placement")).toContainText("1st place");
        await expect(frame.getByTestId("results-final-wager")).toHaveText("+1");
        await expect(frame.getByTestId("results-final-wager")).toHaveClass(/is-won/);
        await expect(frame.getByTestId("results-final-wager-result")).toHaveText("Wager won");
        await expect(frame.getByTestId("results-final-score")).toHaveText("2 points");
        await expect(frame.getByTestId("results-podium").locator("li")).toHaveCount(2);
        await expect(frame.getByTestId("results-final-wagers").locator('[data-outcome="won"]')).toHaveCount(1);
        await expect(frame.getByTestId("results-final-wagers").locator('[data-outcome="lost"]')).toHaveCount(1);
        await expect(
            frame
                .getByTestId("results-leaderboard")
                .locator(".results-score")
                .filter({ hasText: /^2$/ }),
        ).toBeVisible();

        await charlieDone;
        const scores = await charlie.query<(number | bigint)[]>("getScores", [gameId]);
        expect(scores.map(Number).sort((a, b) => b - a)).toEqual([2, 0]);
    } finally {
        releaseCharlieDifficultyVote?.();
        charlie.destroy();
    }
});
