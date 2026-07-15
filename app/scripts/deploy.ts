/**
 * Deploy the Quizzler contracts to Paseo Asset Hub via pallet-revive's
 * `instantiate_with_code`.
 *
 * Two contracts: the pack REGISTRY (stable data — packs survive game
 * iterations) and the GAME (logic — redeployed freely, constructed with the
 * registry's address). An existing registry in contract-address.json is
 * reused; the game is always redeployed.
 *
 * Usage:
 *   pnpm deploy:contract                    # signs with dev //Alice
 *   pnpm deploy:registry-migration           # stage a fresh registry + game
 *   DEPLOY_DEV_ACCOUNT=Bob pnpm deploy:contract
 *
 * Build the contracts first:
 *   cd ../contracts/registry && cargo pvm-contract build
 *   cd ../contracts/quizzler && cargo pvm-contract build
 */

import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountId, createClient, type PolkadotClient, type PolkadotSigner } from "polkadot-api";
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
const GAME_BASE = join(CONTRACTS, "quizzler", "target", "quizzler.release");
const ADDRESS_FILE = join(__dirname, "..", "src", "contract-address.json");
const MIGRATION_FILE = join(__dirname, "..", ".quizzler-registry-migration.json");
const E2E_ADDRESS_FILE = join(__dirname, "..", ".quizzler-e2e-contract-address.json");

const RPC = process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";
const DEV_ACCOUNT = (process.env.DEPLOY_DEV_ACCOUNT ?? "Alice") as Parameters<typeof createDevSigner>[0];
// `REDEPLOY_REGISTRY=1` used to replace the active app configuration before
// content was seeded. Treat it as the staged workflow now so it cannot leave
// players pointed at an empty registry.
const STAGE_REGISTRY_MIGRATION =
    process.env.DEPLOY_REGISTRY_MIGRATION === "1" || process.env.REDEPLOY_REGISTRY === "1";
// Public LIVE_E2E creates deliberately disposable packs and games. It gets a
// separate, ignored contract pair and must never write the player-facing app
// address file.
const DEPLOY_E2E_PROFILE = process.env.DEPLOY_E2E_PROFILE === "1";

function sha256(contents: Uint8Array): string {
    return createHash("sha256").update(contents).digest("hex");
}

interface StagedMigration {
    registry?: string;
    deployer?: string;
    deployedAt?: string;
    migration?: {
        kind?: string;
        status?: string;
        artifacts?: {
            registryAbiSha256?: string;
            registryCodeSha256?: string;
            gameAbiSha256?: string;
            gameCodeSha256?: string;
        };
    };
}

interface RegistryArtifacts {
    registryAbiSha256: string;
    registryCodeSha256: string;
}

function isAddress(value: unknown): value is `0x${string}` {
    return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Reuse a registry if its paired game failed to deploy before staging completed. */
async function pendingMigrationRegistry(): Promise<StagedMigration | null> {
    let raw: string;
    try {
        raw = await readFile(MIGRATION_FILE, "utf8");
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    const state = JSON.parse(raw) as StagedMigration;
    if (
        state.migration?.kind === "fresh-registry"
        && state.migration.status === "registry-deployed"
        && isAddress(state.registry)
        && process.env.REPLACE_REGISTRY_MIGRATION !== "1"
    ) {
        return state;
    }
    if (state.migration?.status !== "promoted" && process.env.REPLACE_REGISTRY_MIGRATION !== "1") {
        throw new Error(
            `A pending registry migration already exists at ${MIGRATION_FILE}. Resume its deploy/seed step, or set REPLACE_REGISTRY_MIGRATION=1 only if you deliberately abandon it.`,
        );
    }
    return null;
}

async function registryArtifactsFromBuild(): Promise<RegistryArtifacts> {
    const [abi, code] = await Promise.all([
        readFile(`${REGISTRY_BASE}.abi.json`),
        readFile(`${REGISTRY_BASE}.polkavm`),
    ]);
    return { registryAbiSha256: sha256(abi), registryCodeSha256: sha256(code) };
}

async function assertPendingRegistryArtifactMatchesBuild(state: StagedMigration): Promise<RegistryArtifacts> {
    const expected = state.migration?.artifacts;
    if (!expected?.registryAbiSha256 || !expected.registryCodeSha256) {
        throw new Error(`Pending migration at ${MIGRATION_FILE} has no registry artifact fingerprints.`);
    }
    const actual = await registryArtifactsFromBuild();
    if (
        actual.registryAbiSha256 !== expected.registryAbiSha256
        || actual.registryCodeSha256 !== expected.registryCodeSha256
    ) {
        throw new Error(
            "The registry build artifacts changed after the registry was staged. Rebuild/re-stage instead of pairing that registry with a new game.",
        );
    }
    return actual;
}

/**
 * Never pair a freshly generated registry ABI with an older live registry.
 * Tuple layouts and method selectors are part of the contract boundary, so an
 * ABI change is a registry migration, not a routine game redeploy.
 */
async function assertActiveRegistryAbiMatchesBuild(): Promise<void> {
    const [activeAbi, builtAbi] = await Promise.all([
        readFile(join(__dirname, "..", "src", "abi-registry.json")),
        readFile(`${REGISTRY_BASE}.abi.json`),
    ]);
    if (sha256(activeAbi) !== sha256(builtAbi)) {
        throw new Error(
            "The registry ABI changed. Run `pnpm deploy:registry-migration`, seed the fresh registry, and promote it instead of redeploying only the game.",
        );
    }
}

/** LIVE_E2E direct callers use the app's checked-in game ABI as well. */
async function assertActiveGameAbiMatchesBuild(): Promise<void> {
    const [activeAbi, builtAbi] = await Promise.all([
        readFile(join(__dirname, "..", "src", "abi-game.json")),
        readFile(`${GAME_BASE}.abi.json`),
    ]);
    if (sha256(activeAbi) !== sha256(builtAbi)) {
        throw new Error(
            "The game ABI changed. Promote the matching app ABI before deploying an isolated LIVE_E2E profile.",
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
            subscription = tx.signSubmitAndWatch(signer).subscribe({
                next: (event: any) => {
                    if (event.type !== "finalized") return;
                    if (!event.ok) {
                        finish(new Error(`${label} failed: ${JSON.stringify(event.dispatchError, bigintReplacer)}`));
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
    client: PolkadotClient,
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
        address, 0n, undefined, undefined,
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
    const addr = instantiatedContractAddress(result.events ?? []);
    console.log(`  ${label} at ${addr} (finalized block #${result.block?.number ?? "unknown"})`);
    return { address: addr, bytecodeSha256: sha256(artifacts.bytecode) };
}

async function main(): Promise<void> {
    if (STAGE_REGISTRY_MIGRATION && DEPLOY_E2E_PROFILE) {
        throw new Error("Choose either DEPLOY_REGISTRY_MIGRATION or DEPLOY_E2E_PROFILE, not both.");
    }
    const pendingMigration = STAGE_REGISTRY_MIGRATION ? await pendingMigrationRegistry() : null;
    if (!STAGE_REGISTRY_MIGRATION) await assertActiveRegistryAbiMatchesBuild();
    if (DEPLOY_E2E_PROFILE) await assertActiveGameAbiMatchesBuild();
    let registryArtifacts = pendingMigration
        ? await assertPendingRegistryArtifactMatchesBuild(pendingMigration)
        : undefined;
    const client = createClient(getWsProvider(RPC));
    const api = client.getTypedApi(paseo_asset_hub);
    const signer = createDevSigner(DEV_ACCOUNT);
    const address = AccountId(0).dec(getDevPublicKey(DEV_ACCOUNT));
    const deployer = ss58ToH160(address).toLowerCase();
    console.log(`Deploying as //${DEV_ACCOUNT} (${address}) on ${RPC}`);

    if (pendingMigration?.deployer && pendingMigration.deployer.toLowerCase() !== deployer) {
        throw new Error(
            `The pending registry migration was started by ${pendingMigration.deployer}. Re-run with the same DEPLOY_DEV_ACCOUNT so its starter catalog has one canonical creator.`,
        );
    }

    await ensureAccountMapped(address, signer, {
        addressIsMapped: async (addr: string) =>
            (await api.query.Revive.OriginalAccount.getValue(ss58ToH160(addr))) !== undefined,
    }, api);

    if (process.env.REDEPLOY_REGISTRY === "1" && process.env.DEPLOY_REGISTRY_MIGRATION !== "1") {
        console.log("REDEPLOY_REGISTRY=1 now stages a registry migration; active app files will not change yet.");
    }

    const existing = STAGE_REGISTRY_MIGRATION || DEPLOY_E2E_PROFILE
        ? { registry: pendingMigration?.registry ?? "" }
        : JSON.parse(await readFile(ADDRESS_FILE, "utf8")) as { registry?: string };
    let registry = existing.registry ?? "";
    let deployedRegistryCodeSha256: string | undefined;
    const migrationDeployedAt = pendingMigration?.deployedAt ?? new Date().toISOString();
    const migrationDeployer = pendingMigration?.deployer ?? deployer;
    if (!registry) {
        const deployedRegistry = await instantiate(client, api, signer, address, "registry", REGISTRY_BASE, new Uint8Array(0));
        registry = deployedRegistry.address;
        deployedRegistryCodeSha256 = deployedRegistry.bytecodeSha256;
        if (STAGE_REGISTRY_MIGRATION) {
            const currentArtifacts = await registryArtifactsFromBuild();
            registryArtifacts = {
                ...currentArtifacts,
                registryCodeSha256: deployedRegistry.bytecodeSha256,
            };
        }
        console.log("  (fresh registry — seed it before promoting it to the app)");
        if (STAGE_REGISTRY_MIGRATION) {
            await writeFile(
                MIGRATION_FILE,
                `${JSON.stringify(
                    {
                        registry,
                        deployer: migrationDeployer,
                        chain: "paseo-asset-hub",
                        deployedAt: migrationDeployedAt,
                        migration: {
                            kind: "fresh-registry",
                            status: "registry-deployed",
                            starterPacksSeededAt: null,
                            artifacts: registryArtifacts,
                        },
                    },
                    null,
                    4,
                )}\n`,
            );
        }
    } else if (STAGE_REGISTRY_MIGRATION) {
        console.log(`Resuming staged registry at ${registry}`);
    } else {
        console.log(`Reusing registry at ${registry}`);
    }

    const gameCtorData = hexToBytes(
        encodeAbiParameters([{ type: "address" }], [registry as `0x${string}`]),
    );
    const deployedGame = await instantiate(client, api, signer, address, "game", GAME_BASE, gameCtorData);
    const game = deployedGame.address;

    if (STAGE_REGISTRY_MIGRATION) {
        const [registryAbi, registryCode, gameAbi, gameCode] = await Promise.all([
            readFile(`${REGISTRY_BASE}.abi.json`),
            readFile(`${REGISTRY_BASE}.polkavm`),
            readFile(`${GAME_BASE}.abi.json`),
            readFile(`${GAME_BASE}.polkavm`),
        ]);
        if (!registryArtifacts) throw new Error("missing staged registry artifact fingerprints");
        if (
            sha256(registryAbi) !== registryArtifacts.registryAbiSha256
            || sha256(registryCode) !== registryArtifacts.registryCodeSha256
            || sha256(gameCode) !== deployedGame.bytecodeSha256
        ) {
            throw new Error(
                "Build artifacts changed during deployment. The registry remains staged; rebuild/re-stage before continuing.",
            );
        }
        await writeFile(
            MIGRATION_FILE,
            `${JSON.stringify(
                {
                    registry,
                    game,
                    deployer: migrationDeployer,
                    chain: "paseo-asset-hub",
                    deployedAt: migrationDeployedAt,
                    migration: {
                        kind: "fresh-registry",
                        status: "deployed",
                        starterPacksSeededAt: null,
                        artifacts: {
                            registryAbiSha256: registryArtifacts.registryAbiSha256,
                            registryCodeSha256: registryArtifacts.registryCodeSha256,
                            gameAbiSha256: sha256(gameAbi),
                            gameCodeSha256: deployedGame.bytecodeSha256,
                        },
                    },
                },
                null,
                4,
            )}\n`,
        );
        console.log(`\nStaged ${MIGRATION_FILE}`);
        console.log("Next: pnpm seed:registry-migration (the active app is still unchanged)");
    } else if (DEPLOY_E2E_PROFILE) {
        const [registryAbi, registryCode, gameAbi, gameCode] = await Promise.all([
            readFile(`${REGISTRY_BASE}.abi.json`),
            readFile(`${REGISTRY_BASE}.polkavm`),
            readFile(`${GAME_BASE}.abi.json`),
            readFile(`${GAME_BASE}.polkavm`),
        ]);
        if (
            !deployedRegistryCodeSha256
            || sha256(registryCode) !== deployedRegistryCodeSha256
            || sha256(gameCode) !== deployedGame.bytecodeSha256
        ) {
            throw new Error("Build artifacts changed during E2E deployment. Re-run deploy:e2e-contracts.");
        }
        await writeFile(
            E2E_ADDRESS_FILE,
            `${JSON.stringify(
                {
                    registry,
                    game,
                    chain: "paseo-asset-hub",
                    deployedAt: new Date().toISOString(),
                    profile: "e2e",
                    registryAbiSha256: sha256(registryAbi),
                    gameAbiSha256: sha256(gameAbi),
                },
                null,
                4,
            )}\n`,
        );
        console.log(`\nWrote isolated LIVE_E2E profile to ${E2E_ADDRESS_FILE}`);
    } else {
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
    }

    client.destroy();
}

function bigintReplacer(_k: string, v: unknown): unknown {
    return typeof v === "bigint" ? v.toString() : v;
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
