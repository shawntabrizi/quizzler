import { type PackFile, validatePack } from "./pack-validation";

/**
 * v2 makes difficulty a property of every question and removes special final
 * records. This app is unreleased, so intentionally do not carry migration
 * code for invalid old drafts.
 */
export const PACK_DRAFT_VERSION = 2 as const;
export const PACK_DRAFT_EXPORT_FORMAT = "quizzler-pack-draft" as const;
export const PACK_DRAFT_STORAGE_NAMESPACE = "quizzler:pack-draft:v2:";
/** Matches the bounded raw UTF-8 artwork invariant enforced by the registry. */
export const MAX_PACK_EMOJI_BYTES = 32;

export type PackPublishPhase = "create" | "questions" | "seal";

/** Local-only metadata. `emoji` is the raw UTF-8 string the creator chose. */
export interface PackDraftMetadata {
    id: string;
    name: string;
    emoji: string;
    createdAt: number;
    updatedAt: number;
}

/**
 * Durable progress for a publish operation. It is deliberately local: the
 * chain remains the source of truth, while this lets the UI resume after a
 * refresh or a transient RPC failure.
 */
export interface PackPublishResume {
    version: typeof PACK_DRAFT_VERSION;
    /** Hash of the validated pack plus its raw cover emoji. */
    contentHash: string;
    /** Null until the create-pack transaction is confirmed. */
    packId: number | null;
    /** Persisted before create so a refresh can resolve the nonce safely. */
    creationNonce?: string;
    phase: PackPublishPhase;
    /** Number of questions confirmed on-chain, starting at zero. */
    nextQuestion: number;
    createdAt: number;
    updatedAt: number;
}

export interface PackDraft {
    version: typeof PACK_DRAFT_VERSION;
    metadata: PackDraftMetadata;
    /** The editor text exactly as the author last saved it, including invalid work-in-progress JSON. */
    rawJson: string;
    publishResume?: PackPublishResume;
}

export interface CreatePackDraftInput {
    id?: string;
    name?: string;
    emoji?: string;
    rawJson?: string;
    now?: number;
}

export interface UpdatePackDraftInput {
    name?: string;
    emoji?: string;
    rawJson?: string;
    /** Explicitly set or clear progress; content changes clear it by default. */
    publishResume?: PackPublishResume | null;
    now?: number;
}

export interface PackDraftValidationIssue {
    code: "json" | "pack" | "emoji" | "draft-export";
    message: string;
}

export type PackDraftValidation =
    | {
        valid: true;
        pack: PackFile;
        emoji: string;
        /** Stable SHA-256 digest of canonical publish content, including raw emoji. */
        contentHash: string;
        issues: [];
    }
    | {
        valid: false;
        /** Useful for showing whether an invalid editor buffer has changed. */
        contentHash: string;
        issues: PackDraftValidationIssue[];
    };

export interface PackFileExportOptions {
    /** Include raw emoji as a compatible extra field alongside the PackFile shape. */
    emoji?: string;
    indent?: number;
}

export interface PackDraftImportOptions {
    id?: string;
    name?: string;
    /** Used only when the imported document does not supply an emoji. */
    emoji?: string;
    now?: number;
}

export interface ImportedPackDraft {
    source: "pack-file" | "draft-export";
    draft: PackDraft;
    validation: PackDraftValidation;
}

interface PackDraftExportV2 {
    format: typeof PACK_DRAFT_EXPORT_FORMAT;
    version: typeof PACK_DRAFT_VERSION;
    name: string;
    emoji: string;
    rawJson: string;
}

const EMPTY_PACK: PackFile = {
    title: "Untitled pack",
    questions: [
        { text: "Question", answers: ["Answer"], difficulty: "easy" },
        { text: "Another question", answers: ["Answer"], difficulty: "medium" },
    ],
};

/** A valid starter document lets an author edit or replace it immediately. */
export const EMPTY_PACK_JSON = JSON.stringify(EMPTY_PACK, null, 2);

type PackEmojiValidation =
    | { valid: true; emoji: string; bytes: number }
    | { valid: false; emoji: string; bytes: number; error: string };

/**
 * Deliberately does not try to maintain an "is emoji" Unicode table. The
 * chain accepts any non-empty bounded raw UTF-8 artwork, which keeps modern
 * flags, skin tones, and ZWJ sequences portable through drafts and exports.
 */
export function validatePackEmoji(value: unknown): PackEmojiValidation {
    if (typeof value !== "string") {
        return { valid: false, emoji: "", bytes: 0, error: "Choose an emoji for the pack cover." };
    }
    const bytes = new TextEncoder().encode(value).length;
    if (!value.trim()) {
        return { valid: false, emoji: value, bytes, error: "Choose an emoji for the pack cover." };
    }
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
        return { valid: false, emoji: value, bytes, error: "Pack emojis cannot contain control characters." };
    }
    if (bytes > MAX_PACK_EMOJI_BYTES) {
        return {
            valid: false,
            emoji: value,
            bytes,
            error: `Pack emojis can be at most ${MAX_PACK_EMOJI_BYTES} UTF-8 bytes.`,
        };
    }
    return { valid: true, emoji: value, bytes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function timestamp(value: number | undefined): number {
    return validTimestamp(value) ? Math.floor(value) : Date.now();
}

function draftName(value: string | undefined): string {
    return value?.trim() || "Untitled pack";
}

function newDraftId(): string {
    try {
        const crypto = (globalThis as typeof globalThis & { crypto?: Crypto }).crypto;
        if (crypto?.randomUUID) return `draft-${crypto.randomUUID()}`;
    } catch {
        // Some privacy-restricted browser contexts expose a throwing crypto getter.
    }
    return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneResume(resume: PackPublishResume): PackPublishResume {
    return { ...resume };
}

function cloneDraft(draft: PackDraft): PackDraft {
    return {
        ...draft,
        metadata: { ...draft.metadata },
        ...(draft.publishResume ? { publishResume: cloneResume(draft.publishResume) } : {}),
    };
}

/** Create a named local draft without requiring a connected wallet or chain. */
export function createPackDraft(input: CreatePackDraftInput = {}): PackDraft {
    const now = timestamp(input.now);
    return {
        version: PACK_DRAFT_VERSION,
        metadata: {
            id: input.id?.trim() || newDraftId(),
            name: draftName(input.name),
            emoji: input.emoji ?? "✨",
            createdAt: now,
            updatedAt: now,
        },
        rawJson: input.rawJson ?? EMPTY_PACK_JSON,
    };
}

/**
 * Edits to publishable content invalidate a saved resume cursor. Naming a
 * draft does not. A caller that has reconciled the cursor can pass an explicit
 * `publishResume` to replace it.
 */
export function updatePackDraft(draft: PackDraft, input: UpdatePackDraftInput): PackDraft {
    const rawJson = input.rawJson ?? draft.rawJson;
    const emoji = input.emoji ?? draft.metadata.emoji;
    const contentChanged = rawJson !== draft.rawJson || emoji !== draft.metadata.emoji;
    const explicitlyChangedResume = Object.prototype.hasOwnProperty.call(input, "publishResume");
    const publishResume = explicitlyChangedResume
        ? input.publishResume ?? undefined
        : contentChanged
            ? undefined
            : draft.publishResume;

    return {
        version: PACK_DRAFT_VERSION,
        metadata: {
            ...draft.metadata,
            name: input.name === undefined ? draft.metadata.name : draftName(input.name),
            emoji,
            updatedAt: timestamp(input.now),
        },
        rawJson,
        ...(publishResume ? { publishResume: cloneResume(publishResume) } : {}),
    };
}

function canonicalPack(pack: PackFile): PackFile {
    return {
        title: pack.title,
        questions: pack.questions.map((question) => ({
            text: question.text,
            answers: [...question.answers],
            difficulty: question.difficulty,
        })),
    };
}

// SHA-256 is kept local and synchronous so content checks work in every
// supported browser context, including ones where Web Crypto is unavailable.
const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
    return (value >>> bits) | (value << (32 - bits));
}

/** Exported for deterministic tests and for future integrity indicators in the editor. */
export function sha256Hex(value: string): string {
    const input = new TextEncoder().encode(value);
    const bitLength = BigInt(input.length) * 8n;
    const paddingLength = (64 - ((input.length + 1 + 8) % 64)) % 64;
    const bytes = new Uint8Array(input.length + 1 + paddingLength + 8);
    bytes.set(input);
    bytes[input.length] = 0x80;
    for (let index = 0; index < 8; index += 1) {
        bytes[bytes.length - 8 + index] = Number((bitLength >> BigInt((7 - index) * 8)) & 0xffn);
    }

    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;
    const words = new Uint32Array(64);

    for (let offset = 0; offset < bytes.length; offset += 64) {
        for (let word = 0; word < 16; word += 1) {
            const index = offset + word * 4;
            words[word] = ((bytes[index] << 24) | (bytes[index + 1] << 16) | (bytes[index + 2] << 8) | bytes[index + 3]) >>> 0;
        }
        for (let word = 16; word < 64; word += 1) {
            const lower = rotateRight(words[word - 15], 7) ^ rotateRight(words[word - 15], 18) ^ (words[word - 15] >>> 3);
            const upper = rotateRight(words[word - 2], 17) ^ rotateRight(words[word - 2], 19) ^ (words[word - 2] >>> 10);
            words[word] = (words[word - 16] + lower + words[word - 7] + upper) >>> 0;
        }

        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        let f = h5;
        let g = h6;
        let h = h7;

        for (let word = 0; word < 64; word += 1) {
            const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choose = (e & f) ^ (~e & g);
            const temp1 = (h + sigma1 + choose + SHA256_K[word] + words[word]) >>> 0;
            const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (sigma0 + majority) >>> 0;

            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }

        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }

    return [h0, h1, h2, h3, h4, h5, h6, h7]
        .map((word) => word.toString(16).padStart(8, "0"))
        .join("");
}

/** A content-addressed resume guard; whitespace-only JSON edits do not invalidate it. */
export function packContentHash(pack: PackFile, emoji: string): string {
    return `sha256:${sha256Hex(JSON.stringify({ version: PACK_DRAFT_VERSION, emoji, pack: canonicalPack(pack) }))}`;
}

/** Useful while JSON is invalid and there is no canonical PackFile to hash yet. */
export function rawDraftContentHash(rawJson: string, emoji: string): string {
    return `sha256:${sha256Hex(JSON.stringify({ version: PACK_DRAFT_VERSION, emoji, rawJson }))}`;
}

function issue(code: PackDraftValidationIssue["code"], error: unknown): PackDraftValidationIssue {
    return { code, message: error instanceof Error ? error.message : String(error) };
}

/** Parse raw PackFile JSON and validate both authoring content and cover artwork. */
export function validatePackDraftContent(rawJson: string, emoji: string): PackDraftValidation {
    const issues: PackDraftValidationIssue[] = [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawJson);
    } catch (error) {
        issues.push(issue("json", error));
    }

    let pack: PackFile | undefined;
    if (parsed !== undefined) {
        try {
            pack = validatePack(parsed);
        } catch (error) {
            issues.push(issue("pack", error));
        }
    }

    const emojiValidation = validatePackEmoji(emoji);
    if (!emojiValidation.valid) issues.push({ code: "emoji", message: emojiValidation.error });

    if (!pack || !emojiValidation.valid) {
        return { valid: false, contentHash: rawDraftContentHash(rawJson, emoji), issues };
    }
    return {
        valid: true,
        pack,
        emoji: emojiValidation.emoji,
        contentHash: packContentHash(pack, emojiValidation.emoji),
        issues: [],
    };
}

export function validatePackDraft(draft: PackDraft): PackDraftValidation {
    return validatePackDraftContent(draft.rawJson, draft.metadata.emoji);
}

export interface CreatePackPublishResumeInput {
    contentHash: string;
    packId?: number | null;
    creationNonce?: string | bigint;
    phase?: PackPublishPhase;
    nextQuestion?: number;
    now?: number;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
}

function validCreationNonce(value: unknown): value is string {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
    try {
        return BigInt(value) <= 0xffff_ffff_ffff_ffffn;
    } catch {
        return false;
    }
}

function normalizedCreationNonce(value: string | bigint | undefined): string | undefined {
    if (value === undefined) return undefined;
    const raw = typeof value === "bigint" ? value.toString() : value;
    if (!validCreationNonce(raw)) throw new Error("A creation nonce must be an unsigned uint64 integer.");
    return raw;
}

/** Start a resumable publisher cursor after obtaining a validated content hash. */
export function createPackPublishResume(input: CreatePackPublishResumeInput): PackPublishResume {
    if (!input.contentHash) throw new Error("A publish resume requires a content hash.");
    const now = timestamp(input.now);
    const packId = input.packId === undefined ? null : input.packId;
    if (packId !== null && (!Number.isSafeInteger(packId) || packId < 0)) {
        throw new Error("A publish resume pack id must be a non-negative integer.");
    }
    const phase = input.phase ?? (packId === null ? "create" : "questions");
    if (!(["create", "questions", "seal"] as const).includes(phase)) {
        throw new Error("A publish resume phase is invalid.");
    }
    const creationNonce = normalizedCreationNonce(input.creationNonce);
    return {
        version: PACK_DRAFT_VERSION,
        contentHash: input.contentHash,
        packId,
        ...(creationNonce ? { creationNonce } : {}),
        phase,
        nextQuestion: nonNegativeInteger(input.nextQuestion, 0),
        createdAt: now,
        updatedAt: now,
    };
}

/** A saved cursor is usable only against exactly the same validated publish content. */
export function canResumePackPublish(draft: PackDraft, validation = validatePackDraft(draft)): boolean {
    return validation.valid
        && draft.publishResume !== undefined
        && draft.publishResume.contentHash === validation.contentHash;
}

/**
 * Export only the portable PackFile shape (plus optional raw emoji metadata).
 * This is the preferred format for sharing a quiz with another author.
 */
export function exportPackFile(pack: PackFile, options: PackFileExportOptions = {}): string {
    const checked = validatePack(pack);
    if (options.emoji === undefined) return JSON.stringify(checked, null, options.indent ?? 2);
    const emoji = validatePackEmoji(options.emoji);
    if (!emoji.valid) throw new Error(emoji.error);
    return JSON.stringify({ ...checked, emoji: emoji.emoji }, null, options.indent ?? 2);
}

/**
 * Export the local editor buffer for backup/recovery. Unlike exportPackFile it
 * intentionally preserves invalid in-progress JSON, but never exports a
 * chain-specific publish cursor that could be unsafe in another wallet.
 */
export function exportPackDraft(draft: PackDraft): string {
    const document: PackDraftExportV2 = {
        format: PACK_DRAFT_EXPORT_FORMAT,
        version: PACK_DRAFT_VERSION,
        name: draft.metadata.name,
        emoji: draft.metadata.emoji,
        rawJson: draft.rawJson,
    };
    return JSON.stringify(document, null, 2);
}

function invalidImport(rawJson: string, emoji: string, message: string): PackDraftValidation {
    return {
        valid: false,
        contentHash: rawDraftContentHash(rawJson, emoji),
        issues: [{ code: "draft-export", message }],
    };
}

/**
 * Import either a portable PackFile JSON document or a local draft backup.
 * Invalid text is retained as a named draft so the editor can show errors and
 * let the author fix it instead of discarding their work.
 */
export function importPackDraft(rawJson: string, options: PackDraftImportOptions = {}): ImportedPackDraft {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawJson);
    } catch {
        const draft = createPackDraft({
            id: options.id,
            name: options.name ?? "Imported pack",
            emoji: options.emoji ?? "✨",
            rawJson,
            now: options.now,
        });
        return { source: "pack-file", draft, validation: validatePackDraft(draft) };
    }

    if (isRecord(parsed) && parsed.format === PACK_DRAFT_EXPORT_FORMAT) {
        if (parsed.version !== PACK_DRAFT_VERSION || typeof parsed.name !== "string" || typeof parsed.emoji !== "string" || typeof parsed.rawJson !== "string") {
            const draft = createPackDraft({
                id: options.id,
                name: options.name ?? "Imported pack",
                emoji: options.emoji ?? "✨",
                rawJson,
                now: options.now,
            });
            return {
                source: "draft-export",
                draft,
                validation: invalidImport(rawJson, draft.metadata.emoji, "This Quizzler draft export is malformed or unsupported."),
            };
        }
        const draft = createPackDraft({
            id: options.id,
            name: options.name ?? parsed.name,
            emoji: parsed.emoji,
            rawJson: parsed.rawJson,
            now: options.now,
        });
        return { source: "draft-export", draft, validation: validatePackDraft(draft) };
    }

    const importedEmoji = isRecord(parsed) && typeof parsed.emoji === "string"
        ? parsed.emoji
        : options.emoji ?? "✨";
    const importedName = options.name ?? (isRecord(parsed) && typeof parsed.title === "string" ? parsed.title : "Imported pack");
    const draft = createPackDraft({
        id: options.id,
        name: importedName,
        emoji: importedEmoji,
        rawJson,
        now: options.now,
    });
    return { source: "pack-file", draft, validation: validatePackDraft(draft) };
}

function validPublishResume(value: unknown): value is PackPublishResume {
    if (!isRecord(value)) return false;
    const packId = value.packId;
    const creationNonce = value.creationNonce;
    const phase = value.phase;
    const nextQuestion = value.nextQuestion;
    if (!isRecord(value)
        || value.version !== PACK_DRAFT_VERSION
        || typeof value.contentHash !== "string"
        || !value.contentHash
        || (packId !== null && (typeof packId !== "number" || !Number.isSafeInteger(packId) || packId < 0))
        || (creationNonce !== undefined && !validCreationNonce(creationNonce))
        || typeof phase !== "string"
        || !["create", "questions", "seal"].includes(phase)
        || typeof nextQuestion !== "number"
        || !Number.isSafeInteger(nextQuestion)
        || nextQuestion < 0
        || !validTimestamp(value.createdAt)
        || !validTimestamp(value.updatedAt)) {
        return false;
    }
    return true;
}

/** Validate persisted records without requiring their editor text to be valid yet. */
export function isPackDraft(value: unknown): value is PackDraft {
    return isRecord(value)
        && value.version === PACK_DRAFT_VERSION
        && isRecord(value.metadata)
        && typeof value.metadata.id === "string"
        && Boolean(value.metadata.id)
        && typeof value.metadata.name === "string"
        && typeof value.metadata.emoji === "string"
        && validTimestamp(value.metadata.createdAt)
        && validTimestamp(value.metadata.updatedAt)
        && typeof value.rawJson === "string"
        && (value.publishResume === undefined || validPublishResume(value.publishResume));
}

export interface PackDraftStore {
    list(): Promise<PackDraft[]>;
    get(id: string): Promise<PackDraft | null>;
    save(draft: PackDraft): Promise<void>;
    delete(id: string): Promise<void>;
}

function sortedDrafts(drafts: PackDraft[]): PackDraft[] {
    return drafts.sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt || a.metadata.name.localeCompare(b.metadata.name));
}

/** Useful for tests, server rendering, and private browsing fallbacks. */
export function createMemoryPackDraftStore(initial: readonly PackDraft[] = []): PackDraftStore {
    const drafts = new Map<string, PackDraft>();
    for (const draft of initial) {
        if (isPackDraft(draft)) drafts.set(draft.metadata.id, cloneDraft(draft));
    }
    return {
        async list() {
            return sortedDrafts([...drafts.values()].map(cloneDraft));
        },
        async get(id) {
            const draft = drafts.get(id);
            return draft ? cloneDraft(draft) : null;
        },
        async save(draft) {
            if (!isPackDraft(draft)) throw new Error("Cannot save an invalid pack draft record.");
            drafts.set(draft.metadata.id, cloneDraft(draft));
        },
        async delete(id) {
            drafts.delete(id);
        },
    };
}

/** Minimal Storage interface keeps the adapter easy to test and safe in SSR. */
export interface BrowserStorageLike {
    readonly length: number;
    key(index: number): string | null;
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

function draftStorageKey(id: string, namespace: string): string {
    return `${namespace}${encodeURIComponent(id)}`;
}

/**
 * Robust localStorage adapter: each draft is independent, and one malformed
 * record cannot prevent the rest of an author's drafts from loading.
 */
export function createLocalStoragePackDraftStore(
    storage: BrowserStorageLike,
    namespace = PACK_DRAFT_STORAGE_NAMESPACE,
): PackDraftStore {
    return {
        async list() {
            const drafts: PackDraft[] = [];
            for (let index = 0; index < storage.length; index += 1) {
                let key: string | null;
                try {
                    key = storage.key(index);
                } catch {
                    continue;
                }
                if (!key?.startsWith(namespace)) continue;
                try {
                    const raw = storage.getItem(key);
                    if (!raw) continue;
                    const draft: unknown = JSON.parse(raw);
                    if (isPackDraft(draft)) drafts.push(cloneDraft(draft));
                } catch {
                    // Keep corrupt data untouched for possible manual recovery.
                }
            }
            return sortedDrafts(drafts);
        },
        async get(id) {
            try {
                const raw = storage.getItem(draftStorageKey(id, namespace));
                if (!raw) return null;
                const draft: unknown = JSON.parse(raw);
                return isPackDraft(draft) ? cloneDraft(draft) : null;
            } catch {
                return null;
            }
        },
        async save(draft) {
            if (!isPackDraft(draft)) throw new Error("Cannot save an invalid pack draft record.");
            storage.setItem(draftStorageKey(draft.metadata.id, namespace), JSON.stringify(cloneDraft(draft)));
        },
        async delete(id) {
            storage.removeItem(draftStorageKey(id, namespace));
        },
    };
}

interface IndexedDbDraftRecord {
    id: string;
    draft: PackDraft;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    });
}

function openDraftDatabase(indexedDB: IDBFactory, databaseName: string, storeName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let request: IDBOpenDBRequest;
        try {
            request = indexedDB.open(databaseName, PACK_DRAFT_VERSION);
        } catch (error) {
            reject(error);
            return;
        }
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "id" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB for pack drafts."));
    });
}

/** IndexedDB adapter for larger drafts; it shares the same asynchronous store API as localStorage. */
export function createIndexedDbPackDraftStore(
    indexedDB: IDBFactory,
    databaseName = "quizzler-pack-drafts",
    storeName = "drafts",
): PackDraftStore {
    let database: Promise<IDBDatabase> | undefined;
    const getDatabase = () => database ??= openDraftDatabase(indexedDB, databaseName, storeName);
    return {
        async list() {
            const db = await getDatabase();
            const transaction = db.transaction(storeName, "readonly");
            const done = transactionResult(transaction);
            const records = await requestResult(transaction.objectStore(storeName).getAll()) as IndexedDbDraftRecord[];
            await done;
            return sortedDrafts(records
                .map((record) => record?.draft)
                .filter((draft): draft is PackDraft => isPackDraft(draft))
                .map(cloneDraft));
        },
        async get(id) {
            const db = await getDatabase();
            const transaction = db.transaction(storeName, "readonly");
            const done = transactionResult(transaction);
            const record = await requestResult(transaction.objectStore(storeName).get(id)) as IndexedDbDraftRecord | undefined;
            await done;
            return record && isPackDraft(record.draft) ? cloneDraft(record.draft) : null;
        },
        async save(draft) {
            if (!isPackDraft(draft)) throw new Error("Cannot save an invalid pack draft record.");
            const db = await getDatabase();
            const transaction = db.transaction(storeName, "readwrite");
            const done = transactionResult(transaction);
            transaction.objectStore(storeName).put({ id: draft.metadata.id, draft: cloneDraft(draft) } satisfies IndexedDbDraftRecord);
            await done;
        },
        async delete(id) {
            const db = await getDatabase();
            const transaction = db.transaction(storeName, "readwrite");
            const done = transactionResult(transaction);
            transaction.objectStore(storeName).delete(id);
            await done;
        },
    };
}

export interface BrowserPackDraftStoreOptions {
    /** Pass null to intentionally disable that backend (useful in tests/SSR). */
    indexedDB?: IDBFactory | null;
    storage?: BrowserStorageLike | null;
    databaseName?: string;
    namespace?: string;
}

function browserStorage(): BrowserStorageLike | null {
    try {
        return globalThis.localStorage;
    } catch {
        return null;
    }
}

function browserIndexedDb(): IDBFactory | null {
    try {
        return globalThis.indexedDB;
    } catch {
        return null;
    }
}

/**
 * Prefer IndexedDB for authoring drafts, with localStorage and then memory as
 * graceful fallbacks for private/embedded browser contexts where it is blocked.
 */
export function createBrowserPackDraftStore(options: BrowserPackDraftStoreOptions = {}): PackDraftStore {
    const storage = options.storage === undefined ? browserStorage() : options.storage;
    const fallback = storage
        ? createLocalStoragePackDraftStore(storage, options.namespace)
        : createMemoryPackDraftStore();
    const indexedDB = options.indexedDB === undefined ? browserIndexedDb() : options.indexedDB;
    if (!indexedDB) return fallback;

    const primary = createIndexedDbPackDraftStore(indexedDB, options.databaseName);
    let primaryFailed = false;
    const use = async <T>(operation: (store: PackDraftStore) => Promise<T>): Promise<T> => {
        if (!primaryFailed) {
            try {
                return await operation(primary);
            } catch {
                primaryFailed = true;
            }
        }
        return operation(fallback);
    };
    return {
        list: () => use((store) => store.list()),
        get: (id) => use((store) => store.get(id)),
        save: (draft) => use((store) => store.save(draft)),
        delete: (id) => use((store) => store.delete(id)),
    };
}

export interface DebouncedPackDraftSaverOptions {
    delayMs?: number;
    onError?: (error: unknown) => void;
}

/** Coalesce keystroke-level updates while retaining an explicit flush for navigation/unload. */
export class DebouncedPackDraftSaver {
    private readonly delayMs: number;
    private readonly onError?: (error: unknown) => void;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private pending: PackDraft | undefined;
    private writes: Promise<void> = Promise.resolve();
    private closed = false;
    lastError: unknown;

    constructor(
        private readonly store: PackDraftStore,
        options: DebouncedPackDraftSaverOptions = {},
    ) {
        this.delayMs = Math.max(0, Math.floor(options.delayMs ?? 500));
        this.onError = options.onError;
    }

    schedule(draft: PackDraft): void {
        if (this.closed) throw new Error("This pack draft saver has been disposed.");
        this.pending = cloneDraft(draft);
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush().catch((error: unknown) => {
                this.lastError = error;
                this.onError?.(error);
            });
        }, this.delayMs);
    }

    async flush(): Promise<void> {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        const pending = this.pending;
        this.pending = undefined;
        if (!pending) return this.writes;
        this.writes = this.writes.catch(() => undefined).then(() => this.store.save(pending));
        return this.writes;
    }

    /** Cancel timers without discarding a final write unless the caller asks to. */
    async dispose(flush = true): Promise<void> {
        this.closed = true;
        if (flush) await this.flush();
        else if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        if (!flush) this.pending = undefined;
        if (!flush) await this.writes;
    }
}
