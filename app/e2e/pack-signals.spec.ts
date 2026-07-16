import { expect, test } from "./fixtures";
import { ScriptedPlayer } from "./scripted-player";

type PopularEntry = {
    packId: number;
    favoriteCount: number;
};

/**
 * viem decodes ABI integers as bigint today, while some host/runtime paths
 * expose safe uints as numbers. Keep the live assertion independent of that
 * representation so it verifies the contract behavior rather than its codec.
 */
function chainNumber(value: unknown, label: string): number {
    if (typeof value === "bigint") {
        const result = Number(value);
        if (Number.isSafeInteger(result)) return result;
    }
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    throw new Error(`Expected safe integer ${label}, received ${String(value)}`);
}

function chainBigInt(value: unknown, label: string): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    throw new Error(`Expected integer ${label}, received ${String(value)}`);
}

/** ABI tuples can arrive as named objects or positional arrays. */
function tupleMember(value: unknown, snakeName: string, camelName: string, index: number): unknown {
    if (!value || typeof value !== "object") {
        throw new Error(`Expected tuple containing ${snakeName}`);
    }
    const tuple = value as Record<string, unknown>;
    return tuple[snakeName] ?? tuple[camelName] ?? tuple[index];
}

function favoritePage(value: unknown): { packIds: number[]; nextCursor: bigint; total: number } {
    const rawIds = tupleMember(value, "pack_ids", "packIds", 0);
    if (!Array.isArray(rawIds)) throw new Error("Expected favorite page pack_ids array");
    return {
        packIds: rawIds.map((id) => chainNumber(id, "favorite pack ID")),
        nextCursor: chainBigInt(tupleMember(value, "next_cursor", "nextCursor", 1), "favorite cursor"),
        total: chainNumber(tupleMember(value, "total", "total", 2), "favorite total"),
    };
}

function popularEntry(value: unknown): PopularEntry {
    return {
        packId: chainNumber(tupleMember(value, "pack_id", "packId", 0), "popular pack ID"),
        favoriteCount: chainNumber(tupleMember(value, "favorite_count", "favoriteCount", 1), "popular favorite count"),
    };
}

function popularPage(value: unknown): {
    entries: PopularEntry[];
    nextScore: number;
    nextCursor: bigint;
} {
    const rawEntries = tupleMember(value, "packs", "packs", 0);
    if (!Array.isArray(rawEntries)) throw new Error("Expected popular page packs array");
    return {
        entries: rawEntries.map(popularEntry),
        nextScore: chainNumber(tupleMember(value, "next_score", "nextScore", 1), "popular score cursor"),
        nextCursor: chainBigInt(tupleMember(value, "next_cursor", "nextCursor", 2), "popular node cursor"),
    };
}

async function allFavorites(player: ScriptedPlayer): Promise<number[]> {
    const ids: number[] = [];
    const seenCursors = new Set<bigint>();
    let cursor = 0n;

    // The contract caps pages at 32. This generous guard catches a malformed
    // cursor response without silently looping forever against a live chain.
    for (let pageNumber = 0; pageNumber < 256; pageNumber += 1) {
        const page = favoritePage(await player.query<unknown>("getFavorites", [player.h160, cursor, 32]));
        ids.push(...page.packIds);
        if (page.nextCursor === 0n) return ids;
        if (seenCursors.has(page.nextCursor)) throw new Error("Favorite cursor repeated");
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
    }

    throw new Error("Favorite pagination exceeded its safety bound");
}

async function popularForPack(player: ScriptedPlayer, packId: number): Promise<PopularEntry | undefined> {
    const seenCursors = new Set<string>();
    let cursorScore = 0;
    let cursor = 0n;

    // Unlike the initial rail, the cursor endpoint covers every ranked pack.
    // That keeps this test sound even if an old dedicated E2E deployment has
    // more than 24 previously favorited packs.
    for (let pageNumber = 0; pageNumber < 256; pageNumber += 1) {
        const page = popularPage(
            await player.query<unknown>("getPopularPage", [cursorScore, cursor, 24]),
        );
        const found = page.entries.find((entry) => entry.packId === packId);
        if (found) return found;
        if (page.nextScore === 0 && page.nextCursor === 0n) return undefined;

        const next = `${page.nextScore}:${page.nextCursor}`;
        if (seenCursors.has(next)) throw new Error("Popular cursor repeated");
        seenCursors.add(next);
        cursorScore = page.nextScore;
        cursor = page.nextCursor;
    }

    throw new Error("Popular pagination exceeded its safety bound");
}

async function favoriteCount(player: ScriptedPlayer, packId: number): Promise<number> {
    return chainNumber(await player.query<unknown>("favoriteCount", [packId]), "favorite count");
}

test("tracks favorites and Popular directly on-chain", async () => {
    test.setTimeout(420_000);

    const charlie = await ScriptedPlayer.connect("Charlie");
    const bob = await ScriptedPlayer.connect("Bob");
    try {
        // `createTestPack` creates the content and seals it before returning,
        // so this is an isolated, valid target for PackSignals validation.
        const packId = await charlie.createTestPack(`E2E Pack signals ${Date.now()}`, {
            text: "Which planet is known as the Red Planet?",
            answers: ["Mars"],
        });

        // A repeated save by the same account must remain one relationship
        // rather than incrementing either the pack score or personal list.
        await charlie.tx("setFavorite", [packId, true]);
        await expect.poll(() => favoriteCount(charlie, packId), { timeout: 60_000 }).toBe(1);
        await charlie.tx("setFavorite", [packId, true]);
        await expect.poll(() => favoriteCount(charlie, packId), { timeout: 60_000 }).toBe(1);
        expect((await allFavorites(charlie)).filter((id) => id === packId)).toHaveLength(1);

        // A second distinct owner raises the immutable pack's on-chain score
        // to two. Both personal pages and the globally ranked cursor must
        // independently expose that fact.
        await bob.tx("setFavorite", [packId, true]);
        await expect.poll(() => favoriteCount(charlie, packId), { timeout: 60_000 }).toBe(2);
        expect(await allFavorites(charlie)).toContain(packId);
        expect(await allFavorites(bob)).toContain(packId);
        await expect
            .poll(async () => (await popularForPack(charlie, packId))?.favoriteCount, { timeout: 60_000 })
            .toBe(2);

        // Removing either owner is one decrement and leaves the remaining
        // favorite visible. Removing the final owner clears the score and
        // removes the pack from the on-chain Popular ranking altogether.
        await charlie.tx("setFavorite", [packId, false]);
        await expect.poll(() => favoriteCount(bob, packId), { timeout: 60_000 }).toBe(1);
        expect(await allFavorites(charlie)).not.toContain(packId);
        expect(await allFavorites(bob)).toContain(packId);
        await expect
            .poll(async () => (await popularForPack(bob, packId))?.favoriteCount, { timeout: 60_000 })
            .toBe(1);

        await bob.tx("setFavorite", [packId, false]);
        await expect.poll(() => favoriteCount(charlie, packId), { timeout: 60_000 }).toBe(0);
        expect(await allFavorites(bob)).not.toContain(packId);
        await expect.poll(() => popularForPack(charlie, packId), { timeout: 60_000 }).toBeUndefined();
    } finally {
        charlie.destroy();
        bob.destroy();
    }
});
