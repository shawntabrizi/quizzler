export interface ContractDeployment {
    /** A URL-safe, stable name for this known registry/game pair. */
    id: string;
    registry: string;
    game: string;
    deployedAt?: string;
}

export interface ContractDeploymentConfig {
    registry: string;
    game: string;
    deployedAt?: string;
    deploymentId?: string;
    previousDeployments?: readonly ContractDeployment[];
}

function isAddress(value: unknown): value is `0x${string}` {
    return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Keep invite deployment IDs independent from raw contract addresses. */
export function isDeploymentId(value: unknown): value is string {
    return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value);
}

/** A backwards-compatible ID for old address files that lack an explicit ID. */
export function fallbackDeploymentId(game: string): string {
    return `game-${game.replace(/^0x/i, "").slice(0, 12).toLowerCase()}`;
}

function validDeployment(value: unknown): value is ContractDeployment {
    if (typeof value !== "object" || value === null) return false;
    const item = value as Partial<ContractDeployment>;
    return isDeploymentId(item.id) && isAddress(item.registry) && isAddress(item.game);
}

/**
 * Return the active pair followed by explicitly allowlisted historical pairs.
 * This makes old invites/resume pointers survivable without accepting contract
 * addresses supplied by a URL.
 */
export function deploymentCatalog(config: ContractDeploymentConfig): ContractDeployment[] {
    const current: ContractDeployment = {
        id: isDeploymentId(config.deploymentId) ? config.deploymentId : fallbackDeploymentId(config.game),
        registry: config.registry,
        game: config.game,
        ...(config.deployedAt ? { deployedAt: config.deployedAt } : {}),
    };
    const seen = new Set<string>();
    const records: ContractDeployment[] = [];
    for (const candidate of [current, ...(config.previousDeployments ?? [])]) {
        if (!validDeployment(candidate)) continue;
        const id = candidate.id.toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        records.push({ ...candidate, id, registry: candidate.registry.toLowerCase(), game: candidate.game.toLowerCase() });
    }
    return records;
}

export function resolveDeployment(
    deployments: readonly ContractDeployment[],
    id: string | null | undefined,
): ContractDeployment | null {
    if (id === null || id === undefined) return deployments[0] ?? null;
    return deployments.find((deployment) => deployment.id === id.toLowerCase()) ?? null;
}
