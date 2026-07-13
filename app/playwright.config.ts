import { defineConfig, devices } from "@playwright/test";

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
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
