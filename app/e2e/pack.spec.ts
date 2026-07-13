import { expect, test } from "./fixtures";

test("creates, fills, and seals a pack through the builder UI", async ({ testHost }) => {
    test.setTimeout(420_000);
    await testHost.waitForConnection();
    const frame = testHost.productFrame();
    await expect(frame.getByTestId("conn-pill")).toHaveText("connected", { timeout: 120_000 });

    const title = `E2E Builder ${Date.now()}`;
    await frame.getByTestId("btn-new-pack").click();
    await expect(frame.getByTestId("screen-builder")).toBeVisible();
    await frame.getByTestId("pack-title").fill(title);
    await frame.getByTestId("btn-create-pack").click();

    // question form appears once the createPack tx lands
    await expect(frame.getByTestId("q-text")).toBeVisible({ timeout: 120_000 });

    const questions = [
        { text: "What is the capital of France?", answers: "Paris", kind: "regular" },
        { text: "Easy final: how many days in a week?", answers: "7", kind: "0" },
        { text: "Medium final: what planet is known as the Red Planet?", answers: "Mars", kind: "1" },
        { text: "Hard final: what year did the Berlin Wall fall?", answers: "1989", kind: "2" },
    ];
    for (const q of questions) {
        await frame.getByTestId("q-text").fill(q.text);
        await frame.getByTestId("q-answers").fill(q.answers);
        await frame.getByTestId("q-kind").selectOption(q.kind);
        await frame.getByTestId("btn-add-question").click();
        // row appears in the local list once the tx lands
        await expect(frame.getByTestId("builder-questions").getByText(q.text)).toBeVisible({
            timeout: 120_000,
        });
    }

    await expect(frame.getByTestId("btn-seal-pack")).toBeEnabled();
    await frame.getByTestId("btn-seal-pack").click();

    // sealing returns home and the pack shows up in the browse list
    await expect(frame.getByTestId("screen-home")).toBeVisible({ timeout: 120_000 });
    await expect(frame.getByTestId("pack-list").getByText(title)).toBeVisible();
});
