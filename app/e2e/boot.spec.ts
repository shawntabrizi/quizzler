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
    const nameCard = frame.getByTestId("display-name-card");
    await expect(nameCard).toBeVisible();
    const greeting = frame.getByTestId("home-name-greeting");
    await expect(greeting).toHaveText(/^Welcome, /);
    expect(await greeting.textContent()).not.toMatch(/0x|…/i);
    const nameAction = frame.getByTestId("home-name-action");
    await expect(nameAction).toHaveAccessibleName(/edit your player name/i);
    await expect(nameAction).toHaveAttribute("aria-expanded", "false");
    await nameAction.click();
    await expect(nameAction).toHaveAttribute("aria-expanded", "true");
    await expect(frame.getByTestId("home-name-editor")).toBeVisible();
    await expect(frame.getByTestId("display-name")).toBeFocused();
    await frame.getByTestId("display-name").fill("Party Fox");
    await frame.getByTestId("btn-cancel-display-name").click();
    await expect(frame.getByTestId("home-name-editor")).toBeHidden();
    await expect(greeting).toHaveText(/^Welcome, /);
    await expect(frame.getByTestId("screen-home")).toBeVisible();
    await expect(frame.getByTestId("btn-join-game")).toBeVisible();
    await expect(frame.getByTestId("join-game-id")).toBeVisible();
    const createPack = frame.getByTestId("btn-new-pack");
    await expect(createPack).toBeVisible();
    await expect(createPack).toHaveText("Create a pack");
    await expect(createPack).toHaveClass(/text-link/);
    await expect(createPack.locator("xpath=..")).toHaveClass(/home-secondary-action/);
    await expect(frame.getByTestId("btn-game-settings")).toBeHidden();
});
