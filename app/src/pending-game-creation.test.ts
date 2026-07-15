import { describe, expect, it } from "vitest";

import {
    clearPendingGameCreation,
    pendingGameCreationKey,
    readPendingGameCreation,
    rememberPendingGameCreation,
    type PendingGameCreationStorage,
} from "./pending-game-creation";

const GAME = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
const ACCOUNT = "0x0123456789ABCDEF0123456789ABCDEF01234567";

function memoryStorage(): PendingGameCreationStorage & { values: Map<string, string> } {
    const values = new Map<string, string>();
    return {
        values,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
    };
}

const CONFIG = {
    packId: 7,
    numQuestions: 5,
    answerBlocks: 30,
    reviewBlocks: 18,
};

describe("pending game-creation browser session", () => {
    it("scopes a creation nonce to the game contract and account", () => {
        expect(pendingGameCreationKey(GAME, ACCOUNT)).toBe(
            "quizzler.pending-game-creation.v1:paseo-asset-hub:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:0x0123456789abcdef0123456789abcdef01234567",
        );
    });

    it("round-trips a uint64 nonce and bounded game configuration", () => {
        const storage = memoryStorage();
        expect(rememberPendingGameCreation(storage, GAME, ACCOUNT, {
            nonce: 18_446_744_073_709_551_615n,
            config: CONFIG,
        })).toBe(true);

        expect(readPendingGameCreation(storage, GAME, ACCOUNT)).toEqual({
            nonce: 18_446_744_073_709_551_615n,
            config: CONFIG,
        });
    });

    it("clears malformed or out-of-range records instead of restoring them", () => {
        const storage = memoryStorage();
        const key = pendingGameCreationKey(GAME, ACCOUNT);
        storage.values.set(key, JSON.stringify({
            version: 1,
            nonce: "18446744073709551616",
            config: { ...CONFIG, reviewBlocks: 601 },
        }));

        expect(readPendingGameCreation(storage, GAME, ACCOUNT)).toBeNull();
        expect(storage.values.has(key)).toBe(false);

        storage.values.set(key, "not JSON");
        expect(readPendingGameCreation(storage, GAME, ACCOUNT)).toBeNull();
        expect(storage.values.has(key)).toBe(false);
    });

    it("clears a resolved creation marker", () => {
        const storage = memoryStorage();
        rememberPendingGameCreation(storage, GAME, ACCOUNT, { nonce: 42n, config: CONFIG });
        clearPendingGameCreation(storage, GAME, ACCOUNT);
        expect(readPendingGameCreation(storage, GAME, ACCOUNT)).toBeNull();
    });

    it("rejects invalid values before they can be persisted", () => {
        const storage = memoryStorage();
        expect(() => rememberPendingGameCreation(storage, GAME, ACCOUNT, {
            nonce: -1n,
            config: CONFIG,
        })).toThrow("unsigned uint64");
        expect(() => rememberPendingGameCreation(storage, GAME, ACCOUNT, {
            nonce: 1n,
            config: { ...CONFIG, answerBlocks: 1 },
        })).toThrow("configuration is invalid");
    });
});
