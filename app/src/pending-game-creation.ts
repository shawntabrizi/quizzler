/**
 * Browser-session recovery for the short gap between a game-creation
 * transaction being included and its nonce being resolved to a lobby code.
 *
 * This is intentionally separate from the active-game pointer: a pending
 * creation is not yet a room the UI can resume, and is cleared as soon as the
 * code has been resolved.
 */

export const PENDING_GAME_CREATION_NAMESPACE = "quizzler.pending-game-creation.v1";
export const PENDING_GAME_CREATION_VERSION = 1 as const;

const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;
const MAX_PACK_ID = 0xffff_ffff;
const MAX_GAME_QUESTIONS = 10;
const MIN_STAGE_BLOCKS = 2;
const MAX_STAGE_BLOCKS = 600;
const MAX_PLAYERS = 16;

/** The exact game options needed to render a newly created lobby immediately. */
export interface PendingGameCreationConfig {
    packId: number;
    numQuestions: number;
    answerBlocks: number;
    reviewBlocks: number;
    maxPlayers: number;
}

export interface PendingGameCreation {
    nonce: bigint;
    config: PendingGameCreationConfig;
}

/** The small subset of sessionStorage used here keeps this easy to test. */
export interface PendingGameCreationStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

interface PersistedPendingGameCreation {
    version: typeof PENDING_GAME_CREATION_VERSION;
    nonce: string;
    config: PendingGameCreationConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= minimum
        && value <= maximum;
}

function validNonce(value: unknown): value is string {
    if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return false;
    try {
        return BigInt(value) <= MAX_UINT64;
    } catch {
        return false;
    }
}

/** Match the game contract's bounded creation inputs before persisting them. */
export function isPendingGameCreationConfig(value: unknown): value is PendingGameCreationConfig {
    if (!isRecord(value)) return false;
    return validInteger(value.packId, 0, MAX_PACK_ID)
        && validInteger(value.numQuestions, 1, MAX_GAME_QUESTIONS)
        && validInteger(value.answerBlocks, MIN_STAGE_BLOCKS, MAX_STAGE_BLOCKS)
        && validInteger(value.reviewBlocks, MIN_STAGE_BLOCKS, MAX_STAGE_BLOCKS)
        && validInteger(value.maxPlayers, 1, MAX_PLAYERS);
}

function validPersistedPendingGameCreation(value: unknown): value is PersistedPendingGameCreation {
    return isRecord(value)
        && value.version === PENDING_GAME_CREATION_VERSION
        && validNonce(value.nonce)
        && isPendingGameCreationConfig(value.config);
}

/** Scope a pending nonce to exactly the game deployment and product account. */
export function pendingGameCreationKey(gameAddress: string, account: string): string {
    return [
        PENDING_GAME_CREATION_NAMESPACE,
        "paseo-asset-hub",
        gameAddress.toLowerCase(),
        account.toLowerCase(),
    ].join(":");
}

function persistedRecord(pending: PendingGameCreation): PersistedPendingGameCreation {
    if (pending.nonce < 0n || pending.nonce > MAX_UINT64) {
        throw new Error("A pending game-creation nonce must be an unsigned uint64 integer.");
    }
    if (!isPendingGameCreationConfig(pending.config)) {
        throw new Error("A pending game-creation configuration is invalid.");
    }
    return {
        version: PENDING_GAME_CREATION_VERSION,
        nonce: pending.nonce.toString(),
        config: { ...pending.config },
    };
}

/**
 * Remember an included/in-flight create request. Storage policy failures are
 * non-fatal: the normal in-memory creation flow can still complete.
 */
export function rememberPendingGameCreation(
    storage: PendingGameCreationStorage,
    gameAddress: string,
    account: string,
    pending: PendingGameCreation,
): boolean {
    const encoded = JSON.stringify(persistedRecord(pending));
    try {
        storage.setItem(pendingGameCreationKey(gameAddress, account), encoded);
        return true;
    } catch {
        return false;
    }
}

/**
 * Restore only a structurally valid, contract-bounded record. Malformed
 * records are removed so a stale browser value cannot repeatedly disrupt boot.
 */
export function readPendingGameCreation(
    storage: PendingGameCreationStorage,
    gameAddress: string,
    account: string,
): PendingGameCreation | null {
    const key = pendingGameCreationKey(gameAddress, account);
    let raw: string | null;
    try {
        raw = storage.getItem(key);
    } catch {
        // A blocked storage implementation must not block boot.
        return null;
    }
    if (raw === null) return null;

    try {
        const decoded: unknown = JSON.parse(raw);
        if (validPersistedPendingGameCreation(decoded)) {
            return {
                nonce: BigInt(decoded.nonce),
                config: { ...decoded.config },
            };
        }
    } catch {
        // Treat malformed JSON like every other invalid persisted record.
    }

    try {
        storage.removeItem(key);
    } catch {
        // Invalid data is still ignored when a browser blocks removal.
    }
    return null;
}

/** Clear the durable recovery marker after it resolves to a lobby code. */
export function clearPendingGameCreation(
    storage: PendingGameCreationStorage,
    gameAddress: string,
    account: string,
): void {
    try {
        storage.removeItem(pendingGameCreationKey(gameAddress, account));
    } catch {
        // Storage can be disabled; there is no game-flow reason to surface it.
    }
}
