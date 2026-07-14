import { defineConfig, devices } from "@playwright/test";

// These tests create real contracts, packs, and games on public Paseo using
// shared dev accounts. Make that side effect deliberate rather than a default
// test command someone might run locally or in CI by accident.
if (process.env.LIVE_E2E !== "1") {
    throw new Error("Live E2E targets public Paseo. Re-run with LIVE_E2E=1 to opt in.");
}

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: false,
    workers: 1, // Serial — shared Paseo nonce state, avoid races
    timeout: 300_000, // games span many blocks; allow 5 min per test
    expect: {
        timeout: 60_000,
    },
    retries: process.env.CI ? 1 : 0,
    reporter: [["html", { open: "never" }], ["list"]],

    use: {
        trace: "on-first-retry",
        screenshot: "only-on-failure",
        video: "on-first-retry",
    },

    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],

    webServer: {
        command: "pnpm vite --port 5301",
        port: 5301,
        // A stale server may be serving a different checkout. Reuse is useful
        // for deliberate local debugging only, never as the implicit default.
        reuseExistingServer: process.env.REUSE_E2E_SERVER === "1",
        timeout: 30_000,
    },
});
