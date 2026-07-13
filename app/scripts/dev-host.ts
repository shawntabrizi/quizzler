/**
 * Local two-player playtest: serves two standalone Triangle test hosts, one
 * signing as dev bob and one as dev charlie, both embedding the Vite app.
 * Open both URLs in separate tabs and play against yourself.
 *
 * Prereq: `pnpm dev` running (http://localhost:5301).
 */
import { createTestHostServer, PASEO_ASSET_HUB } from "@parity/host-api-test-sdk";

const PRODUCT_URL = process.env.PRODUCT_URL ?? "http://localhost:5301";
const network = {
    ...PASEO_ASSET_HUB,
    rpcUrl: process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io",
};

const bob = await createTestHostServer({
    productUrl: PRODUCT_URL,
    accounts: ["bob"],
    networks: [network],
    productAccounts: { "quizzler.dot/0": "bob" },
    port: 5310,
});
const charlie = await createTestHostServer({
    productUrl: PRODUCT_URL,
    accounts: ["charlie"],
    networks: [network],
    productAccounts: { "quizzler.dot/0": "charlie" },
    port: 5311,
});

console.log(`Player 1 (bob):     ${bob.url}`);
console.log(`Player 2 (charlie): ${charlie.url}`);
console.log("Open each in its own tab. Ctrl-C to stop.");

process.on("SIGINT", async () => {
    await Promise.all([bob.close(), charlie.close()]);
    process.exit(0);
});
