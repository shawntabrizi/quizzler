import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface E2EContractProfile {
    registry: `0x${string}`;
    game: `0x${string}`;
    profile: "e2e";
    registryAbiSha256: string;
    gameAbiSha256: string;
    chain?: string;
    deployedAt?: string;
}

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultProfile = resolve(appDir, ".quizzler-e2e-contract-address.json");
const activeAddressFile = resolve(appDir, "src", "contract-address.json");
const activeRegistryAbi = resolve(appDir, "src", "abi-registry.json");
const activeGameAbi = resolve(appDir, "src", "abi-game.json");

function profilePath(): string {
    const configured = process.env.E2E_CONTRACT_ADDRESS_FILE;
    if (!configured) return defaultProfile;
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

function isAddress(value: unknown): value is `0x${string}` {
    return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function sha256File(file: string): string {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function activeAddresses(): { registry: `0x${string}`; game: `0x${string}` } {
    const active = JSON.parse(readFileSync(activeAddressFile, "utf8")) as Record<string, unknown>;
    if (!isAddress(active.registry) || !isAddress(active.game)) {
        throw new Error(`Invalid active contract addresses in ${activeAddressFile}.`);
    }
    return { registry: active.registry, game: active.game };
}

/**
 * Live E2E is intentionally isolated from the player-facing registry. The
 * profile is untracked because it contains ephemeral testnet deployments.
 */
function loadE2EContracts(): E2EContractProfile {
    const file = profilePath();
    let profile: unknown;
    try {
        profile = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        throw new Error(
            `Live E2E requires a dedicated contract profile at ${file}. Run pnpm deploy:e2e-contracts first, or set E2E_CONTRACT_ADDRESS_FILE.`,
        );
    }
    const candidate = profile as Record<string, unknown>;
    if (
        !profile
        || typeof profile !== "object"
        || !isAddress(candidate.registry)
        || !isAddress(candidate.game)
        || candidate.profile !== "e2e"
        || typeof candidate.registryAbiSha256 !== "string"
        || !/^[0-9a-f]{64}$/i.test(candidate.registryAbiSha256)
        || typeof candidate.gameAbiSha256 !== "string"
        || !/^[0-9a-f]{64}$/i.test(candidate.gameAbiSha256)
    ) {
        throw new Error(`Invalid E2E contract profile at ${file}: expected an isolated e2e pair and ABI fingerprints.`);
    }
    const active = activeAddresses();
    if (candidate.registry.toLowerCase() === candidate.game.toLowerCase()) {
        throw new Error("Invalid E2E contract profile: registry and game must be different contracts.");
    }
    if (
        candidate.registry.toLowerCase() === active.registry.toLowerCase()
        || candidate.game.toLowerCase() === active.game.toLowerCase()
    ) {
        throw new Error("E2E contract profile points at an active player-facing contract; deploy a dedicated E2E pair instead.");
    }
    if (
        candidate.registryAbiSha256 !== sha256File(activeRegistryAbi)
        || candidate.gameAbiSha256 !== sha256File(activeGameAbi)
    ) {
        throw new Error("E2E contract profile ABI fingerprints do not match the active app ABI; deploy a fresh isolated E2E pair.");
    }
    return {
        registry: candidate.registry,
        game: candidate.game,
        profile: "e2e",
        registryAbiSha256: candidate.registryAbiSha256,
        gameAbiSha256: candidate.gameAbiSha256,
        ...(typeof candidate.chain === "string" ? { chain: candidate.chain } : {}),
        ...(typeof candidate.deployedAt === "string" ? { deployedAt: candidate.deployedAt } : {}),
    };
}

let cachedProfile: E2EContractProfile | null = null;

export function getE2EContracts(): E2EContractProfile {
    cachedProfile ??= loadE2EContracts();
    return cachedProfile;
}
