import { defineConfig } from "bulletin-deploy";

/**
 * Product metadata read by Polkadot's app browser from DotNS.
 *
 * `bulletin-deploy` discovers this file from `dist` during `pnpm deploy:dot`;
 * the regular direct deployment flow therefore publishes the app card as well
 * as the static site, without involving the Playground registry.
 */
export default defineConfig({
    domain: "quizzler.dot",
    displayName: "Quizzler",
    description: "A live social trivia game for friends.",
    icon: { path: "./assets/app-icon.png", format: "png" },
    executables: [{ kind: "app", path: "./dist", appVersion: [0, 1, 0] }],
});
