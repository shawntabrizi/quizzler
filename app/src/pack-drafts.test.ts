import { describe, expect, it, vi } from "vitest";
import type { PackFile } from "./pack-validation";
import {
    DebouncedPackDraftSaver,
    PACK_DRAFT_STORAGE_NAMESPACE,
    canResumePackPublish,
    createBrowserPackDraftStore,
    createLocalStoragePackDraftStore,
    createPackDraft,
    createPackPublishResume,
    exportPackDraft,
    exportPackFile,
    importPackDraft,
    packContentHash,
    sha256Hex,
    updatePackDraft,
    validatePackDraft,
    validatePackDraftContent,
    validatePackEmoji,
    type BrowserStorageLike,
    type PackDraft,
    type PackDraftStore,
} from "./pack-drafts";

const question = { text: "What fruit is used in guacamole?", answers: ["avocado"] };
const pack: PackFile = {
    title: "Friday food quiz",
    questions: [question],
    finals: { easy: question, medium: question, hard: question },
};

class MemoryStorage implements BrowserStorageLike {
    private readonly values = new Map<string, string>();

    get length(): number {
        return this.values.size;
    }

    key(index: number): string | null {
        return [...this.values.keys()][index] ?? null;
    }

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }
}

function validDraft(id: string, now = 100): PackDraft {
    return createPackDraft({ id, name: id, emoji: "🧠", rawJson: JSON.stringify(pack), now });
}

describe("pack drafts", () => {
    it("validates raw PackFile JSON and uses a semantic content hash for resumes", () => {
        const compact = JSON.stringify(pack);
        const formatted = JSON.stringify(pack, null, 2);
        const result = validatePackDraftContent(compact, "👩🏽‍🚀");

        expect(result.valid).toBe(true);
        if (!result.valid) throw new Error("expected a valid pack");
        expect(result.pack).toEqual(pack);
        expect(result.emoji).toBe("👩🏽‍🚀");
        expect(result.contentHash).toBe(packContentHash(pack, "👩🏽‍🚀"));
        expect(validatePackDraftContent(formatted, "👩🏽‍🚀").contentHash).toBe(result.contentHash);
        expect(validatePackDraftContent(formatted, "🍜").contentHash).not.toBe(result.contentHash);
        expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });

    it("retains invalid imported editor text and reports independent JSON and emoji errors", () => {
        const imported = importPackDraft("{ not valid json", { id: "broken", emoji: "x".repeat(33), now: 20 });

        expect(imported.draft.metadata.id).toBe("broken");
        expect(imported.draft.rawJson).toBe("{ not valid json");
        expect(imported.validation.valid).toBe(false);
        if (imported.validation.valid) throw new Error("expected invalid import");
        expect(imported.validation.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining(["json", "emoji"]));
        expect(validatePackEmoji("👨‍👩‍👧‍👦")).toMatchObject({ valid: true, emoji: "👨‍👩‍👧‍👦" });
        expect(validatePackEmoji("x".repeat(33))).toMatchObject({ valid: false, bytes: 33 });
        expect(validatePackEmoji("🎲\n")).toMatchObject({ valid: false });
    });

    it("round-trips both portable PackFile JSON and named draft backups with raw emoji metadata", () => {
        const original = createPackDraft({
            id: "food-draft",
            name: "Friday night's food round",
            emoji: "🇵🇹",
            rawJson: JSON.stringify(pack, null, 2),
            now: 10,
        });

        const archive = importPackDraft(exportPackDraft(original), { id: "restored", now: 11 });
        expect(archive.source).toBe("draft-export");
        expect(archive.draft.metadata).toMatchObject({ id: "restored", name: original.metadata.name, emoji: "🇵🇹" });
        expect(archive.draft.rawJson).toBe(original.rawJson);
        expect(archive.validation.valid).toBe(true);

        const portable = exportPackFile(pack, { emoji: "🥑" });
        const shared = importPackDraft(portable, { id: "shared", now: 12 });
        expect(shared.source).toBe("pack-file");
        expect(shared.draft.metadata).toMatchObject({ id: "shared", name: "Friday food quiz", emoji: "🥑" });
        expect(shared.validation.valid).toBe(true);
    });

    it("invalidates a publish cursor when pack content or raw artwork changes, but not a local name", () => {
        const initial = validDraft("resume", 10);
        const validation = validatePackDraft(initial);
        if (!validation.valid) throw new Error("expected a valid draft");
        const withResume = updatePackDraft(initial, {
            publishResume: createPackPublishResume({ contentHash: validation.contentHash, packId: 42, creationNonce: 42n, now: 11 }),
            now: 11,
        });

        expect(canResumePackPublish(withResume)).toBe(true);
        expect(withResume.publishResume?.creationNonce).toBe("42");
        expect(updatePackDraft(withResume, { name: "Renamed only", now: 12 }).publishResume).toBeDefined();
        expect(updatePackDraft(withResume, { emoji: "🍜", now: 12 }).publishResume).toBeUndefined();
        expect(updatePackDraft(withResume, { rawJson: JSON.stringify({ ...pack, title: "Changed" }), now: 12 }).publishResume).toBeUndefined();
    });

    it("persists independent named drafts, ignores corrupt localStorage rows, and returns defensive copies", async () => {
        const storage = new MemoryStorage();
        const store = createLocalStoragePackDraftStore(storage);
        const older = validDraft("older", 10);
        const newer = validDraft("newer", 20);
        await store.save(older);
        await store.save(newer);
        storage.setItem(`${PACK_DRAFT_STORAGE_NAMESPACE}corrupt`, "not-json");

        expect((await store.list()).map((draft) => draft.metadata.id)).toEqual(["newer", "older"]);
        const loaded = await store.get("older");
        if (!loaded) throw new Error("expected older draft");
        loaded.metadata.name = "mutated in caller";
        expect((await store.get("older"))?.metadata.name).toBe("older");

        await store.delete("newer");
        expect((await store.list()).map((draft) => draft.metadata.id)).toEqual(["older"]);
    });

    it("falls back from a blocked IndexedDB backend to localStorage", async () => {
        const storage = new MemoryStorage();
        const blockedIndexedDb = { open: () => { throw new Error("blocked"); } } as unknown as IDBFactory;
        const store = createBrowserPackDraftStore({ indexedDB: blockedIndexedDb, storage });
        await store.save(validDraft("fallback", 1));

        expect((await store.get("fallback"))?.metadata.name).toBe("fallback");
    });

    it("debounces keystroke-level saves and supports a final explicit flush", async () => {
        vi.useFakeTimers();
        try {
            const saved: string[] = [];
            const store: PackDraftStore = {
                list: async () => [],
                get: async () => null,
                save: async (draft) => { saved.push(draft.metadata.id); },
                delete: async () => undefined,
            };
            const saver = new DebouncedPackDraftSaver(store, { delayMs: 100 });
            saver.schedule(validDraft("first"));
            saver.schedule(validDraft("latest"));
            await vi.advanceTimersByTimeAsync(99);
            expect(saved).toEqual([]);
            await vi.advanceTimersByTimeAsync(1);
            await saver.flush();
            expect(saved).toEqual(["latest"]);

            saver.schedule(validDraft("on-leave"));
            await saver.dispose();
            expect(saved).toEqual(["latest", "on-leave"]);
        } finally {
            vi.useRealTimers();
        }
    });
});
