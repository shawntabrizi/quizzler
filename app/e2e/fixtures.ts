import { test as base } from "@playwright/test";
import {
    createTestHostFixture,
    PASEO_ASSET_HUB,
    type NetworkConfig,
    type TestHost,
} from "@parity/host-api-test-sdk/playwright";

const PRODUCT_URL = "http://localhost:5301";

/**
 * Paseo Asset Hub with a configurable RPC endpoint. An override via
 * `PASEO_AH_RPC` must serve paseo v2 — a v1 mirror will hash-mismatch the
 * spread genesisHash and break the chain handshake.
 */
export const PASEO_AH: NetworkConfig = {
    ...PASEO_ASSET_HUB,
    rpcUrl: process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io",
};

/**
 * The UI player signs as quizzler.dot/0 → bob (funded dev keypair). The
 * second player in game specs is scripted directly against the contract
 * (see scripted-player.ts) — the test host drives a single page.
 */
const fixture = createTestHostFixture({
    productUrl: PRODUCT_URL,
    accounts: ["bob"],
    networks: [PASEO_AH],
    productAccounts: { "quizzler.dot/0": "bob" },
});

export const test = base.extend<{ testHost: TestHost }>(fixture);
export { expect } from "@playwright/test";
