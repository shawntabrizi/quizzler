/**
 * Deploy the Quizzler contracts to Paseo Asset Hub via pallet-revive's
 * `instantiate_with_code`.
 *
 * Two contracts: the pack REGISTRY (stable data — packs survive game
 * iterations) and the GAME (logic — redeployed freely, constructed with the
 * registry's address). An existing registry in contract-address.json is
 * reused unless REDEPLOY_REGISTRY=1; the game is always redeployed.
 *
 * Usage:
 *   pnpm deploy:contract                    # signs with dev //Alice
 *   REDEPLOY_REGISTRY=1 pnpm deploy:contract
 *   DEPLOY_DEV_ACCOUNT=Bob pnpm deploy:contract
 *
 * Build the contracts first:
 *   cd ../contracts/registry && cargo pvm-contract build
 *   cd ../contracts/quizzler && cargo pvm-contract build
 */

import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountId, createClient, type PolkadotClient, type PolkadotSigner } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { loadPvmContractArtifacts } from "@parity/product-sdk-contracts/pvm";
import { createDevSigner, ensureAccountMapped, getDevPublicKey } from "@parity/product-sdk-tx";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { encodeAbiParameters, hexToBytes } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = join(__dirname, "..", "..", "contracts");
const REGISTRY_BASE = join(CONTRACTS, "registry", "target", "quizzler-registry.release");
const GAME_BASE = join(CONTRACTS, "quizzler", "target", "quizzler.release");
const ADDRESS_FILE = join(__dirname, "..", "src", "contract-address.json");

const RPC = process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";
const DEV_ACCOUNT = (process.env.DEPLOY_DEV_ACCOUNT ?? "Alice") as Parameters<typeof createDevSigner>[0];

async function instantiate(
    client: PolkadotClient,
    api: any,
    signer: PolkadotSigner,
    address: string,
    label: string,
    base: string,
    constructorData: Uint8Array,
): Promise<string> {
    const artifacts = await loadPvmContractArtifacts(base);
    console.log(`Deploying ${label} (${artifacts.bytecode.length} bytes)…`);

    const dryRun = await (api as any).apis.ReviveApi.instantiate(
        address, 0n, undefined, undefined,
        { type: "Upload", value: artifacts.bytecode },
        constructorData,
        undefined,
    );
    if (!dryRun.result.success) {
        throw new Error(`${label} dry-run failed: ${JSON.stringify(dryRun.result.value, bigintReplacer)}`);
    }
    const predicted: string = dryRun.result.value.addr;
    const gas = dryRun.weight_required;

    const result = await (api as any).tx.Revive.instantiate_with_code({
        value: 0n,
        weight_limit: {
            ref_time: (gas.ref_time * 13n) / 10n,
            proof_size: (gas.proof_size * 13n) / 10n,
        },
        storage_deposit_limit:
            dryRun.storage_deposit.type === "Charge" ? (dryRun.storage_deposit.value * 13n) / 10n : 0n,
        code: artifacts.bytecode,
        data: constructorData,
        salt: undefined,
    }).signAndSubmit(signer);
    if (!result.ok) {
        throw new Error(`${label} deploy failed: ${JSON.stringify(result.dispatchError, bigintReplacer)}`);
    }
    const instantiated = result.events.find(
        (e: { type: string; value: { type: string } }) =>
            e.type === "Revive" && e.value.type === "Instantiated",
    );
    const addr: string = instantiated ? (instantiated.value as any).value.contract : predicted;
    console.log(`  ${label} at ${addr} (block #${result.block.number})`);
    return addr;
}

async function main(): Promise<void> {
    const client = createClient(getWsProvider(RPC));
    const api = client.getTypedApi(paseo_asset_hub);
    const signer = createDevSigner(DEV_ACCOUNT);
    const address = AccountId(0).dec(getDevPublicKey(DEV_ACCOUNT));
    console.log(`Deploying as //${DEV_ACCOUNT} (${address}) on ${RPC}`);

    await ensureAccountMapped(address, signer, {
        addressIsMapped: async (addr: string) =>
            (await api.query.Revive.OriginalAccount.getValue(ss58ToH160(addr))) !== undefined,
    }, api);

    const existing = JSON.parse(await readFile(ADDRESS_FILE, "utf8")) as { registry?: string };
    let registry = existing.registry ?? "";
    if (!registry || process.env.REDEPLOY_REGISTRY === "1") {
        registry = await instantiate(client, api, signer, address, "registry", REGISTRY_BASE, new Uint8Array(0));
        console.log("  (fresh registry — run `pnpm seed:packs` to populate it)");
    } else {
        console.log(`Reusing registry at ${registry}`);
    }

    const gameCtorData = hexToBytes(
        encodeAbiParameters([{ type: "address" }], [registry as `0x${string}`]),
    );
    const game = await instantiate(client, api, signer, address, "game", GAME_BASE, gameCtorData);

    await writeFile(
        ADDRESS_FILE,
        `${JSON.stringify(
            { registry, game, chain: "paseo-asset-hub", deployedAt: new Date().toISOString() },
            null,
            4,
        )}\n`,
    );
    await copyFile(`${REGISTRY_BASE}.abi.json`, join(__dirname, "..", "src", "abi-registry.json"));
    await copyFile(`${GAME_BASE}.abi.json`, join(__dirname, "..", "src", "abi-game.json"));
    console.log(`\nWrote ${ADDRESS_FILE} and refreshed ABI files`);

    client.destroy();
}

function bigintReplacer(_k: string, v: unknown): unknown {
    return typeof v === "bigint" ? v.toString() : v;
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
