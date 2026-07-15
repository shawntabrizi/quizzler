import { expect, test } from "./fixtures";

test("boots inside the host and reaches the home screen", async ({ testHost }) => {
    await testHost.waitForConnection();
    const frame = testHost.productFrame();

    // Boot completes: signer connect → product account → chain client →
    // contract handle → account mapping (may cost one auto-signed tx).
    await expect(frame.getByTestId("conn-pill")).toHaveText("connected", { timeout: 120_000 });
    await expect(frame.getByTestId("chain-account")).toHaveText(/^[^.]+\.\.\.[^.]+$/);
    await expect(frame.getByTestId("chain-block")).toHaveText(/^#\d/);
    await expect(frame.getByTestId("screen-home")).toBeVisible();
    await expect(frame.getByTestId("btn-join-game")).toBeVisible();
    await expect(frame.getByTestId("btn-new-pack")).toBeVisible();
});
