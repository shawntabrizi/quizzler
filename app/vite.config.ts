import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

interface PackageMetadata {
    version: string;
}

interface ContractStack {
    registry: string;
    sessionRegistry: string;
    packSignals: string;
    game: string;
    chain: string;
}

const appDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("..", import.meta.url));

function readJson(file: string | URL): unknown {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function buildRevision(): string {
    // CI has the source revision explicitly. Local and direct Bulletin
    // deployments derive the same identifier from the checked-out commit.
    const ciRevision = process.env.GITHUB_SHA?.trim();
    if (ciRevision) return ciRevision.slice(0, 7);

    try {
        return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
            cwd: appDirectory,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        // Source archives do not include .git. Keep those builds identifiable
        // without preventing local development from starting.
        return "local";
    }
}

function activeContractStack(): ContractStack {
    const value = readJson(new URL("./src/contract-address.json", import.meta.url)) as Partial<ContractStack>;
    const keys: (keyof ContractStack)[] = ["registry", "sessionRegistry", "packSignals", "game", "chain"];
    if (keys.some((key) => typeof value[key] !== "string" || !value[key]?.trim())) {
        throw new Error("app/src/contract-address.json must identify the active Quizzler contract stack");
    }
    return {
        registry: value.registry!,
        sessionRegistry: value.sessionRegistry!,
        packSignals: value.packSignals!,
        game: value.game!,
        chain: value.chain!,
    };
}

function defaultPackCatalog(): { metadata: unknown; packs: { file: string; content: unknown }[] } {
    const packDirectory = join(repositoryDirectory, "shared", "packs");
    const files = readdirSync(packDirectory)
        .filter((file) => file.endsWith(".json"))
        .sort();
    return {
        metadata: readJson(join(repositoryDirectory, "shared", "starter-pack-metadata.json")),
        // Parsed content means formatting changes do not create a phantom
        // release. A question, answer, difficulty, title, or ordering change
        // does, exactly as the seeded catalog would.
        packs: files.map((file) => ({ file, content: readJson(join(packDirectory, file)) })),
    };
}

const packageMetadata = readJson(new URL("./package.json", import.meta.url)) as PackageMetadata;
if (typeof packageMetadata.version !== "string" || !packageMetadata.version.trim()) {
    throw new Error("app/package.json must contain a version string");
}
const packageVersion = packageMetadata.version;
const sourceRevision = buildRevision();
const appBuildVersion = `v${packageVersion} · ${sourceRevision}`;
const releaseFingerprint = createHash("sha256")
    .update(JSON.stringify({
        app: { version: packageVersion, revision: sourceRevision },
        contracts: activeContractStack(),
        defaultPacks: defaultPackCatalog(),
    }))
    .digest("hex")
    .slice(0, 12);

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
        // A compact whole-release identifier, shown only in game settings.
        // It changes with the frontend, active four-contract stack, or the
        // default pack catalog without asking authors to maintain it by hand.
        __QUIZZLER_RELEASE_FINGERPRINT__: JSON.stringify(releaseFingerprint),
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
