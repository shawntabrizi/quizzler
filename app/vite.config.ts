import { defineConfig } from "vitest/config";

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
