import { parseGameCode } from "./input";

export const KNOWN_GAMES_VERSION = 1 as const;
export const MAX_KNOWN_GAMES = 8;

export interface KnownGame {
    id: bigint;
    lastOpenedAt: number;
}

export interface KnownGamesStore {
    getJSON<T>(key: string): Promise<T | null>;
    setJSON(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
}

interface PersistedKnownGame {
    id: string;
    lastOpenedAt: number;
}

interface PersistedKnownGames {
    version: typeof KNOWN_GAMES_VERSION;
    games: PersistedKnownGame[];
}

export function knownGamesKey(gameAddress: string, account: string): string {
    return [
        "active",
        "paseo-asset-hub",
        gameAddress.toLowerCase(),
        account.toLowerCase(),
    ].join(":");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedTimestamp(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

/** Strictly decode untrusted host/browser storage into a small canonical list. */
export function decodeKnownGames(value: unknown): KnownGame[] {
    if (!isRecord(value) || value.version !== KNOWN_GAMES_VERSION || !Array.isArray(value.games)) return [];
    const byId = new Map<bigint, KnownGame>();
    for (const item of value.games) {
        if (!isRecord(item) || typeof item.id !== "string") continue;
        const id = parseGameCode(item.id);
        const lastOpenedAt = normalizedTimestamp(item.lastOpenedAt);
        if (id === null || lastOpenedAt === null) continue;
        const existing = byId.get(id);
        if (!existing || lastOpenedAt > existing.lastOpenedAt) {
            byId.set(id, { id, lastOpenedAt });
        }
    }
    return [...byId.values()]
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || Number(b.id - a.id))
        .slice(0, MAX_KNOWN_GAMES);
}

export function encodeKnownGames(games: readonly KnownGame[]): PersistedKnownGames {
    return {
        version: KNOWN_GAMES_VERSION,
        games: decodeKnownGames({
            version: KNOWN_GAMES_VERSION,
            games: games.map((game) => ({ id: game.id.toString(), lastOpenedAt: game.lastOpenedAt })),
        }).map((game) => ({ id: game.id.toString(), lastOpenedAt: game.lastOpenedAt })),
    };
}

export function touchKnownGame(games: readonly KnownGame[], id: bigint, now = Date.now()): KnownGame[] {
    const lastOpenedAt = normalizedTimestamp(now);
    if (parseGameCode(id.toString()) === null || lastOpenedAt === null) return decodeKnownGames(encodeKnownGames(games));
    return decodeKnownGames({
        version: KNOWN_GAMES_VERSION,
        games: [
            ...games.filter((game) => game.id !== id).map((game) => ({
                id: game.id.toString(),
                lastOpenedAt: game.lastOpenedAt,
            })),
            { id: id.toString(), lastOpenedAt },
        ],
    });
}

export function removeKnownGame(games: readonly KnownGame[], id: bigint): KnownGame[] {
    return decodeKnownGames({
        version: KNOWN_GAMES_VERSION,
        games: games
            .filter((game) => game.id !== id)
            .map((game) => ({ id: game.id.toString(), lastOpenedAt: game.lastOpenedAt })),
    });
}

export async function readKnownGames(store: KnownGamesStore, key: string): Promise<KnownGame[]> {
    return decodeKnownGames(await store.getJSON<unknown>(key));
}

export async function writeKnownGames(
    store: KnownGamesStore,
    key: string,
    games: readonly KnownGame[],
): Promise<void> {
    const encoded = encodeKnownGames(games);
    if (encoded.games.length === 0) {
        await store.remove(key);
        return;
    }
    await store.setJSON(key, encoded);
}
