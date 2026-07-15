import {
    fallbackDeploymentId,
    isDeploymentId,
    normalizeLobbyPlayerCap,
    type ContractDeployment,
    type ContractDeploymentConfig,
} from "./deployments";

const MAX_PREVIOUS_DEPLOYMENTS = 8;

/** Must match the MAX_PLAYERS limit in newly deployed game contracts. */
export const NEW_GAME_MAX_LOBBY_PLAYERS = 24;

function isAddress(value: unknown): value is string {
    return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function currentRecord(config: ContractDeploymentConfig): ContractDeployment | null {
    if (!isAddress(config.registry) || !isAddress(config.game)) return null;
    return {
        id: isDeploymentId(config.deploymentId) ? config.deploymentId : fallbackDeploymentId(config.game),
        registry: config.registry,
        game: config.game,
        maxPlayers: normalizeLobbyPlayerCap(config.maxPlayers),
        ...(config.deployedAt ? { deployedAt: config.deployedAt } : {}),
    };
}

/** Stable, URL-safe ID for a newly promoted address pair. */
export function deploymentIdForGame(game: string): string {
    return `paseo-${game.replace(/^0x/i, "").slice(0, 14).toLowerCase()}`;
}

/**
 * Promote a new pair without losing a bounded, explicit allowlist of rooms
 * that were open on older game contracts. The browser still keeps only one
 * resumable room; this is compatibility infrastructure, not multi-game UI.
 */
export function promoteDeploymentConfig(
    current: ContractDeploymentConfig,
    next: Omit<ContractDeployment, "id" | "maxPlayers"> & { id?: string; maxPlayers?: number },
): ContractDeploymentConfig {
    const deployment: ContractDeployment = {
        id: isDeploymentId(next.id) ? next.id : deploymentIdForGame(next.game),
        registry: next.registry,
        game: next.game,
        maxPlayers: normalizeLobbyPlayerCap(next.maxPlayers),
        ...(next.deployedAt ? { deployedAt: next.deployedAt } : {}),
    };
    const candidates = [currentRecord(current), ...(current.previousDeployments ?? [])];
    const seenIds = new Set<string>([deployment.id.toLowerCase()]);
    const seenPairs = new Set<string>([`${deployment.registry.toLowerCase()}:${deployment.game.toLowerCase()}`]);
    const previousDeployments: ContractDeployment[] = [];
    for (const candidate of candidates) {
        if (!candidate || !isDeploymentId(candidate.id) || !isAddress(candidate.registry) || !isAddress(candidate.game)) continue;
        const id = candidate.id.toLowerCase();
        const pair = `${candidate.registry.toLowerCase()}:${candidate.game.toLowerCase()}`;
        if (seenIds.has(id) || seenPairs.has(pair)) continue;
        seenIds.add(id);
        seenPairs.add(pair);
        previousDeployments.push({
            ...candidate,
            id,
            registry: candidate.registry.toLowerCase(),
            game: candidate.game.toLowerCase(),
            maxPlayers: normalizeLobbyPlayerCap(candidate.maxPlayers),
        });
        if (previousDeployments.length >= MAX_PREVIOUS_DEPLOYMENTS) break;
    }
    return {
        registry: deployment.registry,
        game: deployment.game,
        maxPlayers: deployment.maxPlayers,
        deploymentId: deployment.id,
        ...(deployment.deployedAt ? { deployedAt: deployment.deployedAt } : {}),
        previousDeployments,
    };
}
