import { expect, test } from "./fixtures";

test("imports, previews, and publishes a pack through Pack studio", async ({ testHost }) => {
    test.setTimeout(420_000);
    await testHost.waitForConnection();
    const frame = testHost.productFrame();
    await expect(frame.getByTestId("conn-pill")).toHaveText("connected", { timeout: 120_000 });

    const title = `E2E Builder ${Date.now()}`;
    await frame.getByTestId("btn-new-pack").click();
    await expect(frame.getByTestId("screen-builder")).toBeVisible();
    await expect(frame.getByTestId("pack-json")).toBeVisible();
    await frame.getByTestId("draft-name").fill(title);
    await frame.getByTestId("pack-emoji").fill("🧪");
    await frame.getByTestId("pack-json").fill(JSON.stringify({
        title,
        questions: [{ text: "What is the capital of France?", answers: ["Paris"] }],
        finals: {
            easy: { text: "Easy final: how many days in a week?", answers: ["7"] },
            medium: { text: "Medium final: what planet is known as the Red Planet?", answers: ["Mars"] },
            hard: { text: "Hard final: what year did the Berlin Wall fall?", answers: ["1989"] },
        },
    }, null, 2));

    await expect(frame.getByTestId("builder-preview")).toContainText(title);
    await expect(frame.getByTestId("btn-publish-pack")).toBeEnabled({ timeout: 30_000 });
    await frame.getByTestId("btn-publish-pack").click();

    // Publishing creates, batches, seals, and takes the host directly to
    // setup with the newly selected immutable pack.
    await expect(frame.getByTestId("screen-configure")).toBeVisible({ timeout: 240_000 });
    await expect(frame.getByTestId("config-pack-title")).toHaveText(title);
    await expect(frame.locator("select")).toHaveCount(0);
    await expect(frame.getByTestId("cfg-questions").locator('input[type="radio"]')).not.toHaveCount(0);
    await expect(frame.getByTestId("cfg-answer-blocks").locator('input[type="radio"]')).toHaveCount(4);
    await expect(frame.getByTestId("cfg-review-blocks").locator('input[type="radio"]')).toHaveCount(4);
    await frame.getByTestId("btn-config-back").click();
    await expect(frame.getByTestId("screen-pack-select")).toBeVisible();
    await expect(frame.getByTestId("pack-list").getByText(title)).toBeVisible();
});
