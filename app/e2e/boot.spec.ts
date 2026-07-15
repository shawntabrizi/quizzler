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
    await expect(frame.getByTestId("chain-account")).toHaveText(/^[^.]+\.\.\.[^.]+$/);
    await expect(frame.getByTestId("screen-home")).toBeVisible();
    await expect(frame.getByTestId("btn-join-game")).toBeVisible();
    await expect(frame.getByTestId("btn-new-pack")).toBeVisible();
});
