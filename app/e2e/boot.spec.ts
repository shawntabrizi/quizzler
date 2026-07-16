import { expect, test } from "./fixtures";

test("boots inside the host and reaches the home screen", async ({ testHost }) => {
    await testHost.waitForConnection();
    const frame = testHost.productFrame();

    // Mapping must precede every product-account contract dry-run. A fresh
    // Desktop-derived account otherwise makes pair verification look like a
    // contract mismatch.
    await expect(frame.getByTestId("conn-pill")).toHaveText("connected", { timeout: 120_000 });
    const bootLog = await frame.getByTestId("boot-log").textContent() ?? "";
    const mappingAt = bootLog.indexOf("Ensuring account is mapped");
    const handlesAt = bootLog.indexOf("Contract handles ready");
    expect(mappingAt).toBeGreaterThanOrEqual(0);
    expect(handlesAt).toBeGreaterThan(mappingAt);
    expect(bootLog).not.toContain("contract mismatch");
    // Chain connectivity remains available to assistive technology and tests,
    // but no longer occupies the player-facing header on every screen.
    await expect(frame.getByTestId("chain-status")).toHaveCount(0);
    await expect(frame.getByTestId("chain-account")).toHaveCount(0);
    await expect(frame.locator("#app-header")).toBeHidden();
    await expect(frame.getByTestId("display-name-card")).toBeVisible();
    await expect(frame.getByTestId("screen-home")).toBeVisible();
    await expect(frame.getByTestId("btn-join-game")).toBeVisible();
    const createPack = frame.getByTestId("btn-new-pack");
    await expect(createPack).toBeVisible();
    await expect(createPack).toHaveText("Create a pack");
    await expect(createPack).toHaveClass(/text-link/);
    await expect(createPack.locator("xpath=..")).toHaveClass(/home-secondary-action/);
    await expect(frame.getByTestId("btn-game-settings")).toBeHidden();
});
