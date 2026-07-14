import { defineConfig, devices } from "@playwright/test";
import { getE2EContracts } from "./e2e/contracts";

// These tests create real contracts, packs, and games on public Paseo using
// shared dev accounts. Make that side effect deliberate rather than a default
// test command someone might run locally or in CI by accident.
if (process.env.LIVE_E2E !== "1") {
    throw new Error("Live E2E targets public Paseo. Re-run with LIVE_E2E=1 to opt in.");
}

const e2eContracts = getE2EContracts();

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
        command: "pnpm vite --port 5302",
        port: 5302,
        // Compile the test host against a dedicated registry/game pair. The
        // player-facing address file is never used by destructive E2E tests.
        env: {
            ...process.env,
            VITE_QUIZZLER_REGISTRY: e2eContracts.registry,
            VITE_QUIZZLER_GAME: e2eContracts.game,
        },
        // E2E receives its own port so it cannot reuse the player-facing dev
        // server (which intentionally points at the active catalog).
        reuseExistingServer: false,
        timeout: 30_000,
    },
});
