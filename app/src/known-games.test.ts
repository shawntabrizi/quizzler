import { describe, expect, it } from "vitest";

import {
    decodeKnownGames,
    encodeKnownGames,
    knownGamesKey,
    MAX_KNOWN_GAMES,
    readKnownGames,
    removeKnownGame,
    touchKnownGame,
    writeKnownGames,
    type KnownGamesStore,
} from "./known-games";

const GAME = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
const ACCOUNT = "0x0123456789ABCDEF0123456789ABCDEF01234567";

function memoryStore(): KnownGamesStore & { values: Map<string, unknown> } {
    const values = new Map<string, unknown>();
    return {
        values,
        async getJSON<T>(key: string) { return (values.get(key) as T | undefined) ?? null; },
        async setJSON(key: string, value: unknown) { values.set(key, value); },
        async remove(key: string) { values.delete(key); },
    };
}

describe("known game recovery", () => {
    it("scopes durable recovery to the contract and player", () => {
        expect(knownGamesKey(GAME, ACCOUNT)).toBe(
            "active:paseo-asset-hub:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:0x0123456789abcdef0123456789abcdef01234567",
        );
    });

    it("rejects malformed entries, deduplicates them, and keeps newest games first", () => {
        expect(decodeKnownGames({
            version: 1,
            games: [
                { id: "123456", lastOpenedAt: 2 },
                { id: "123456", lastOpenedAt: 7 },
                { id: "234567", lastOpenedAt: 4 },
                { id: "not-a-code", lastOpenedAt: 99 },
                { id: "345678", lastOpenedAt: -1 },
            ],
        })).toEqual([
            { id: 123456n, lastOpenedAt: 7 },
            { id: 234567n, lastOpenedAt: 4 },
        ]);
        expect(decodeKnownGames({ version: 2, games: [] })).toEqual([]);
    });

    it("touches, bounds, and removes durable game ids", () => {
        let games = touchKnownGame([], 123456n, 1);
        games = touchKnownGame(games, 234567n, 2);
        games = touchKnownGame(games, 123456n, 3);
        expect(games).toEqual([
            { id: 123456n, lastOpenedAt: 3 },
            { id: 234567n, lastOpenedAt: 2 },
        ]);
        for (let index = 0; index < MAX_KNOWN_GAMES + 2; index += 1) {
            games = touchKnownGame(games, BigInt(300000 + index), 10 + index);
        }
        expect(games).toHaveLength(MAX_KNOWN_GAMES);
        expect(removeKnownGame(games, games[0]!.id)).toHaveLength(MAX_KNOWN_GAMES - 1);
    });

    it("round-trips the canonical data and clears empty storage", async () => {
        const store = memoryStore();
        const key = knownGamesKey(GAME, ACCOUNT);
        const games = touchKnownGame([], 123456n, 42);
        await writeKnownGames(store, key, games);
        expect(await readKnownGames(store, key)).toEqual(games);
        expect(encodeKnownGames(games)).toEqual({
            version: 1,
            games: [{ id: "123456", lastOpenedAt: 42 }],
        });
        await writeKnownGames(store, key, []);
        expect(store.values.has(key)).toBe(false);
    });
});
