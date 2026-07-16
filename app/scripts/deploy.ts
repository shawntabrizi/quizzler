/**
 * Deploy Quizzler's pack registry, session registry, pack-signals, and game
 * contracts to Paseo Asset Hub via pallet-revive's `instantiate_with_code`.
 *
 * The normal command immediately updates the active app address/ABI files.
 * `DEPLOY_E2E_PROFILE=1` instead writes a separate, ignored disposable
 * four-contract profile for the public live E2E suite. Live E2E always gets a
 * fresh registry, so it can never write player-facing catalog or favorite data.
 *
 * Usage:
 *   pnpm deploy:contract
 *   DEPLOY_DEV_ACCOUNT=Bob pnpm deploy:contract
 *   pnpm deploy:e2e-contracts
 *
 * Build all contracts first:
 *   cd ../contracts/registry && cargo pvm-contract build
 *   cd ../contracts/session-registry && cargo pvm-contract build
 *   cd ../contracts/pack-signals && cargo pvm-contract build
 *   cd ../contracts/quizzler && cargo pvm-contract build
 */

import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountId, createClient, type PolkadotSigner } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { loadPvmContractArtifacts } from "@parity/product-sdk-contracts/pvm";
import { createDevSigner, ensureAccountMapped, getDevPublicKey } from "@parity/product-sdk-tx";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { encodeAbiParameters, hexToBytes } from "viem";

import { instantiatedContractAddress } from "../src/deployment-events";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = join(__dirname, "..", "..", "contracts");
const REGISTRY_BASE = join(CONTRACTS, "registry", "target", "quizzler-registry.release");
const SESSION_REGISTRY_BASE = join(CONTRACTS, "session-registry", "target", "quizzler-session-registry.release");
const PACK_SIGNALS_BASE = join(CONTRACTS, "pack-signals", "target", "quizzler-pack-signals.release");
const GAME_BASE = join(CONTRACTS, "quizzler", "target", "quizzler.release");
const ADDRESS_FILE = join(__dirname, "..", "src", "contract-address.json");
const E2E_ADDRESS_FILE = join(__dirname, "..", ".quizzler-e2e-contract-address.json");

const RPC = process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";
const DEV_ACCOUNT = (process.env.DEPLOY_DEV_ACCOUNT ?? "Alice") as Parameters<typeof createDevSigner>[0];
const DEPLOY_E2E_PROFILE = process.env.DEPLOY_E2E_PROFILE === "1";

function sha256(contents: Uint8Array): string {
    return createHash("sha256").update(contents).digest("hex");
}

/**
 * ABI JSON is copied verbatim during deploy but is also formatted in source
 * control. Fingerprint its parsed value so harmless whitespace changes do not
 * make a valid E2E profile look stale.
 */
function sha256Abi(contents: Uint8Array): string {
    return sha256(new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(contents)))));
}

/**
 * The live E2E runner decodes calls with the checked-in app ABIs. Refuse to
 * create an isolated profile if a local contract build has not been copied
 * into those files yet.
 */
async function assertActiveAppAbisMatchBuild(): Promise<void> {
    const [
        activeRegistryAbi,
        activeSessionRegistryAbi,
        activePackSignalsAbi,
        activeGameAbi,
        builtRegistryAbi,
        builtSessionRegistryAbi,
        builtPackSignalsAbi,
        builtGameAbi,
    ] = await Promise.all([
        readFile(join(__dirname, "..", "src", "abi-registry.json")),
        readFile(join(__dirname, "..", "src", "abi-session-registry.json")),
        readFile(join(__dirname, "..", "src", "abi-pack-signals.json")),
        readFile(join(__dirname, "..", "src", "abi-game.json")),
        readFile(`${REGISTRY_BASE}.abi.json`),
        readFile(`${SESSION_REGISTRY_BASE}.abi.json`),
        readFile(`${PACK_SIGNALS_BASE}.abi.json`),
        readFile(`${GAME_BASE}.abi.json`),
    ]);
    if (
        sha256Abi(activeRegistryAbi) !== sha256Abi(builtRegistryAbi) ||
        sha256Abi(activeSessionRegistryAbi) !== sha256Abi(builtSessionRegistryAbi) ||
        sha256Abi(activePackSignalsAbi) !== sha256Abi(builtPackSignalsAbi) ||
        sha256Abi(activeGameAbi) !== sha256Abi(builtGameAbi)
    ) {
        throw new Error(
            "The checked-in app ABI files do not match this contract build. Deploy the active four-contract stack first, then deploy an isolated LIVE_E2E profile.",
        );
    }
}

/**
 * Deployment addresses are durable configuration, so only record them after
 * finalization. Best-block inclusion can be reorged out; its dry-run address
 * then describes a contract that never existed on the canonical chain.
 */
async function submitFinalized(tx: any, signer: PolkadotSigner, label: string): Promise<any> {
    return new Promise((resolve, reject) => {
        let subscription: { unsubscribe(): void } | null = null;
        let settled = false;
        const finish = (error?: Error, value?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            subscription?.unsubscribe();
            if (error) reject(error);
            else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error(`${label} timed out waiting for finalization`)), 120_000);
        try {
            // Mortal txs cannot linger in the pool across reruns and collide
            // with a later run's manually assigned nonces.
            subscription = tx
                .signSubmitAndWatch(signer, {
                    mortality: { mortal: true, period: 256 },
                })
                .subscribe({
                    next: (event: any) => {
                        if (event.type !== "finalized") return;
                        if (!event.ok) {
                            finish(
                                new Error(`${label} failed: ${JSON.stringify(event.dispatchError, bigintReplacer)}`),
                            );
                        } else {
                            finish(undefined, event);
                        }
                    },
                    error: (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
                });
        } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

async function instantiate(
    api: any,
    signer: PolkadotSigner,
    address: string,
    label: string,
    base: string,
    constructorData: Uint8Array,
): Promise<{ address: string; bytecodeSha256: string }> {
    const artifacts = await loadPvmContractArtifacts(base);
    console.log(`Deploying ${label} (${artifacts.bytecode.length} bytes)…`);

    const dryRun = await (api as any).apis.ReviveApi.instantiate(
        address,
        0n,
        undefined,
        undefined,
        { type: "Upload", value: artifacts.bytecode },
        constructorData,
        undefined,
    );
    if (!dryRun.result.success) {
        throw new Error(`${label} dry-run failed: ${JSON.stringify(dryRun.result.value, bigintReplacer)}`);
    }
    const gas = dryRun.weight_required;
    const tx = (api as any).tx.Revive.instantiate_with_code({
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
    });
    const result: any = await submitFinalized(tx, signer, `${label} deploy`);
    if (!result.ok) {
        throw new Error(`${label} deploy failed: ${JSON.stringify(result.dispatchError, bigintReplacer)}`);
    }
    const deployedAddress = instantiatedContractAddress(result.events ?? []);
    console.log(`  ${label} at ${deployedAddress} (finalized block #${result.block?.number ?? "unknown"})`);
    return {
        address: deployedAddress,
        bytecodeSha256: sha256(artifacts.bytecode),
    };
}

async function main(): Promise<void> {
    if (DEPLOY_E2E_PROFILE) await assertActiveAppAbisMatchBuild();

    const client = createClient(getWsProvider(RPC));
    try {
        const api = client.getTypedApi(paseo_asset_hub);
        const signer = createDevSigner(DEV_ACCOUNT);
        const address = AccountId(0).dec(getDevPublicKey(DEV_ACCOUNT));
        console.log(`Deploying as //${DEV_ACCOUNT} (${address}) on ${RPC}`);

        await ensureAccountMapped(
            address,
            signer,
            {
                addressIsMapped: async (account: string) =>
                    (await api.query.Revive.OriginalAccount.getValue(ss58ToH160(account))) !== undefined,
            },
            api,
        );

        const deployedRegistry = await instantiate(api, signer, address, "registry", REGISTRY_BASE, new Uint8Array(0));
        const registry = deployedRegistry.address;
        const deployedSessionRegistry = await instantiate(
            api,
            signer,
            address,
            "session registry",
            SESSION_REGISTRY_BASE,
            new Uint8Array(0),
        );
        const sessionRegistry = deployedSessionRegistry.address;
        const linkedContractConstructorData = hexToBytes(
            encodeAbiParameters(
                [{ type: "address" }, { type: "address" }],
                [registry as `0x${string}`, sessionRegistry as `0x${string}`],
            ),
        );
        const deployedPackSignals = await instantiate(
            api,
            signer,
            address,
            "pack signals",
            PACK_SIGNALS_BASE,
            linkedContractConstructorData,
        );
        const packSignals = deployedPackSignals.address;
        const deployedGame = await instantiate(api, signer, address, "game", GAME_BASE, linkedContractConstructorData);
        const game = deployedGame.address;
        const [
            registryAbi,
            sessionRegistryAbi,
            packSignalsAbi,
            gameAbi,
            registryCode,
            sessionRegistryCode,
            packSignalsCode,
            gameCode,
        ] = await Promise.all([
            readFile(`${REGISTRY_BASE}.abi.json`),
            readFile(`${SESSION_REGISTRY_BASE}.abi.json`),
            readFile(`${PACK_SIGNALS_BASE}.abi.json`),
            readFile(`${GAME_BASE}.abi.json`),
            readFile(`${REGISTRY_BASE}.polkavm`),
            readFile(`${SESSION_REGISTRY_BASE}.polkavm`),
            readFile(`${PACK_SIGNALS_BASE}.polkavm`),
            readFile(`${GAME_BASE}.polkavm`),
        ]);

        if (
            sha256(registryCode) !== deployedRegistry.bytecodeSha256 ||
            sha256(sessionRegistryCode) !== deployedSessionRegistry.bytecodeSha256 ||
            sha256(packSignalsCode) !== deployedPackSignals.bytecodeSha256 ||
            sha256(gameCode) !== deployedGame.bytecodeSha256
        ) {
            throw new Error("Build artifacts changed during deployment. Rebuild and deploy again.");
        }

        if (DEPLOY_E2E_PROFILE) {
            await writeFile(
                E2E_ADDRESS_FILE,
                `${JSON.stringify(
                    {
                        registry,
                        sessionRegistry,
                        packSignals,
                        game,
                        chain: "paseo-asset-hub",
                        deployedAt: new Date().toISOString(),
                        profile: "e2e",
                        registryAbiSha256: sha256Abi(registryAbi),
                        sessionRegistryAbiSha256: sha256Abi(sessionRegistryAbi),
                        packSignalsAbiSha256: sha256Abi(packSignalsAbi),
                        gameAbiSha256: sha256Abi(gameAbi),
                    },
                    null,
                    4,
                )}\n`,
            );
            console.log(`\nWrote isolated LIVE_E2E profile to ${E2E_ADDRESS_FILE}`);
            return;
        }

        // Refresh ABI files before switching the active address set, so a
        // failed copy cannot redirect the app to a partially configured stack.
        await Promise.all([
            copyFile(`${REGISTRY_BASE}.abi.json`, join(__dirname, "..", "src", "abi-registry.json")),
            copyFile(`${SESSION_REGISTRY_BASE}.abi.json`, join(__dirname, "..", "src", "abi-session-registry.json")),
            copyFile(`${PACK_SIGNALS_BASE}.abi.json`, join(__dirname, "..", "src", "abi-pack-signals.json")),
            copyFile(`${GAME_BASE}.abi.json`, join(__dirname, "..", "src", "abi-game.json")),
        ]);
        await writeFile(
            ADDRESS_FILE,
            `${JSON.stringify({ registry, sessionRegistry, packSignals, game, chain: "paseo-asset-hub", deployedAt: new Date().toISOString() }, null, 4)}\n`,
        );
        console.log(`\nWrote active four-contract stack to ${ADDRESS_FILE} and refreshed ABI files`);
    } finally {
        client.destroy();
    }
}

function bigintReplacer(_key: string, value: unknown): unknown {
    return typeof value === "bigint" ? value.toString() : value;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
