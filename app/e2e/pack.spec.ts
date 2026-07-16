import { expect, test } from "./fixtures";
import type { Locator } from "@playwright/test";

async function expectDockedAtViewportBottom(dock: Locator): Promise<void> {
    const geometry = await dock.evaluate((element) => {
        const { top, bottom } = element.getBoundingClientRect();
        return { top, bottom, viewportHeight: window.innerHeight };
    });

    // A dock may leave room for a device's safe-area inset, but it should
    // remain reachable at the bottom while the setup content itself scrolls.
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
    expect(geometry.bottom).toBeGreaterThan(geometry.viewportHeight - 96);
}

test("imports, previews, and publishes a pack through Pack studio", async ({ testHost }) => {
    test.setTimeout(420_000);
    await testHost.waitForConnection();
    await testHost.page.setViewportSize({ width: 390, height: 844 });
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
        questions: [
            { text: "What is the capital of France?", answers: ["Paris"], difficulty: "easy" },
            { text: "How many days are in a week?", answers: ["7"], difficulty: "medium" },
        ],
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
    await expect(frame.getByTestId("btn-config-back")).toHaveCount(0);
    const configDock = frame.getByTestId("config-bottom-nav");
    await expect(configDock.getByTestId("btn-config-back-bottom")).toBeVisible();
    await expect(configDock.getByTestId("btn-create-game")).toBeVisible();
    await frame.locator("#screen-configure .setup-scroll").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
    });
    await expectDockedAtViewportBottom(configDock);

    await frame.getByTestId("btn-config-back-bottom").click();
    await expect(frame.getByTestId("screen-pack-select")).toBeVisible();
    await expect(frame.getByTestId("btn-new-pack-from-picker")).toHaveCount(0);
    const packDock = frame.getByTestId("pack-bottom-nav");
    await expect(packDock.getByTestId("btn-pack-back")).toBeVisible();
    await expect(packDock.getByTestId("btn-pack-continue")).toBeVisible();
    await expect(packDock.locator("button")).toHaveCount(2);
    await frame.locator(".pack-catalog").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
    });
    await expectDockedAtViewportBottom(packDock);
    await expect(frame.getByTestId("pack-list").getByText(title)).toBeVisible();
});
