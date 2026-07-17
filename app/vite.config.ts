import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

interface PackageMetadata {
    version: string;
}

function buildRevision(): string {
    // CI has the source revision explicitly. Local and direct Bulletin
    // deployments derive the same identifier from the checked-out commit.
    const ciRevision = process.env.GITHUB_SHA?.trim();
    if (ciRevision) return ciRevision.slice(0, 7);

    try {
        return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
            cwd: fileURLToPath(new URL(".", import.meta.url)),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        // Source archives do not include .git. Keep those builds identifiable
        // without preventing local development from starting.
        return "local";
    }
}

const { version: packageVersion } = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as PackageMetadata;
const appBuildVersion = `v${packageVersion} · ${buildRevision()}`;

export default defineConfig({
    // vitest: only unit tests — e2e/*.spec.ts belongs to Playwright
    test: {
        include: ["src/**/*.test.ts"],
    },
    base: "./",
    // Strip `import.meta.vitest` blocks so workspace packages that embed
    // in-source vitest tests don't leak top-level `await import(...)` into
    // the production bundle.
    define: {
        "import.meta.vitest": "undefined",
        // This is compiled into the app, so both subtle UI footers identify
        // the exact commit that was deployed. Every merged PR has a new HEAD.
        __QUIZZLER_APP_BUILD_VERSION__: JSON.stringify(appBuildVersion),
    },
    server: {
        port: 5301,
    },
    build: {
        outDir: "dist",
        // Never inline assets as data: URIs — the Triangle sandbox CSP can
        // reject inline content, and hashed files cache independently.
        assetsInlineLimit: 0,
    },
});
