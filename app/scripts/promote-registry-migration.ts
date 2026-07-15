/**
 * Make a fully seeded fresh registry/game pair the app's active deployment.
 *
 * This deliberately has no chain calls. `seed:registry-migration` must have
 * completed first and recorded its verification marker in the ignored staging
 * file. Promotion then updates the tracked address and ABI files together.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { starterPacks } from "./starter-packs";
import { starterCatalogFingerprint } from "./catalog-fingerprint";
import { NEW_GAME_MAX_LOBBY_PLAYERS, promoteDeploymentConfig } from "../src/deployment-history";
import type { ContractDeploymentConfig } from "../src/deployments";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, "..");
const CONTRACTS_DIR = join(APP_DIR, "..", "contracts");
const MIGRATION_FILE = join(APP_DIR, ".quizzler-registry-migration.json");
const ACTIVE_ADDRESS_FILE = join(APP_DIR, "src", "contract-address.json");
const ACTIVE_REGISTRY_ABI_FILE = join(APP_DIR, "src", "abi-registry.json");
const ACTIVE_GAME_ABI_FILE = join(APP_DIR, "src", "abi-game.json");
const REGISTRY_ABI_FILE = join(CONTRACTS_DIR, "registry", "target", "quizzler-registry.release.abi.json");
const GAME_ABI_FILE = join(CONTRACTS_DIR, "quizzler", "target", "quizzler.release.abi.json");

interface MigrationState {
    registry?: string;
    game?: string;
    chain?: string;
    deployedAt?: string;
    migration?: {
        kind?: string;
        status?: string;
        starterPacksSeededAt?: string | null;
        starterPackFiles?: string[];
        catalogSha256?: string;
        promotedAt?: string;
        artifacts?: {
            registryAbiSha256?: string;
            registryCodeSha256?: string;
            gameAbiSha256?: string;
            gameCodeSha256?: string;
        };
    };
}

function isAddress(value: unknown): value is `0x${string}` {
    return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function sameFiles(left: readonly string[] | undefined, right: readonly string[]): boolean {
    if (!left || left.length !== right.length) return false;
    const seen = new Set(left);
    return seen.size === right.length && right.every((file) => seen.has(file));
}

function sha256(contents: Uint8Array): string {
    return createHash("sha256").update(contents).digest("hex");
}

async function main(): Promise<void> {
    if (process.env.CONFIRM_PROMOTE_REGISTRY !== "1") {
        throw new Error(
            "Promotion changes the live app contract addresses. Re-run with CONFIRM_PROMOTE_REGISTRY=1 after reviewing the staged deployment.",
        );
    }

    const state = JSON.parse(await readFile(MIGRATION_FILE, "utf8")) as MigrationState;
    if (
        !isAddress(state.registry)
        || !isAddress(state.game)
        || state.chain !== "paseo-asset-hub"
        || state.migration?.kind !== "fresh-registry"
        || state.migration.status !== "seeded"
        || !state.migration.starterPacksSeededAt
        || !sameFiles(state.migration.starterPackFiles, starterPacks.map((pack) => pack.file))
        || !state.migration.catalogSha256
        || !state.migration.artifacts?.registryAbiSha256
        || !state.migration.artifacts.registryCodeSha256
        || !state.migration.artifacts.gameAbiSha256
        || !state.migration.artifacts.gameCodeSha256
    ) {
        throw new Error(
            `Refusing to promote ${MIGRATION_FILE}: it is not a fully seeded fresh-registry migration state.`,
        );
    }

    // Verify both generated artifacts exist before changing any active app
    // file. They are copied only after the new ABI has seeded and verified the
    // starter catalog, so the old app never points at an empty registry.
    const catalog = await starterCatalogFingerprint();
    if (catalog.sha256 !== state.migration.catalogSha256) {
        throw new Error("Starter catalog changed since it was seeded. Re-stage/reseed before promotion.");
    }

    const [registryAbi, registryCode, gameAbi, gameCode] = await Promise.all([
        readFile(REGISTRY_ABI_FILE),
        readFile(join(CONTRACTS_DIR, "registry", "target", "quizzler-registry.release.polkavm")),
        readFile(GAME_ABI_FILE),
        readFile(join(CONTRACTS_DIR, "quizzler", "target", "quizzler.release.polkavm")),
    ]);
    if (
        sha256(registryAbi) !== state.migration.artifacts.registryAbiSha256
        || sha256(registryCode) !== state.migration.artifacts.registryCodeSha256
        || sha256(gameAbi) !== state.migration.artifacts.gameAbiSha256
        || sha256(gameCode) !== state.migration.artifacts.gameCodeSha256
    ) {
        throw new Error("Generated ABI artifacts no longer match the staged deployment. Rebuild/re-stage before promotion.");
    }

    const currentConfig = JSON.parse(await readFile(ACTIVE_ADDRESS_FILE, "utf8")) as ContractDeploymentConfig;
    const promotedConfig = promoteDeploymentConfig(currentConfig, {
        registry: state.registry,
        game: state.game,
        maxPlayers: NEW_GAME_MAX_LOBBY_PLAYERS,
        deployedAt: state.deployedAt,
    });

    await writeFile(ACTIVE_REGISTRY_ABI_FILE, registryAbi);
    await writeFile(ACTIVE_GAME_ABI_FILE, gameAbi);
    await writeFile(
        ACTIVE_ADDRESS_FILE,
        `${JSON.stringify(
            {
                ...promotedConfig,
                chain: state.chain,
            },
            null,
            4,
        )}\n`,
    );

    state.migration = { ...state.migration, status: "promoted", promotedAt: new Date().toISOString() };
    await writeFile(MIGRATION_FILE, `${JSON.stringify(state, null, 4)}\n`);
    console.log("Promoted the fresh registry and game. Rebuild/redeploy the app, then commit the updated address and ABI files.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
