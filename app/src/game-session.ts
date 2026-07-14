import { parseGameCode } from "./input";

/**
 * Browser-only pointer to the room the player last had open. The contract is
 * still authoritative for membership; this merely makes a page refresh feel
 * like staying at the same table.
 */
export const ACTIVE_GAME_SESSION_NAMESPACE = "quizzler.active-game.v1";

export function activeGameSessionKey(gameAddress: string, account: string): string {
    return [
        ACTIVE_GAME_SESSION_NAMESPACE,
        "paseo-asset-hub",
        gameAddress.toLowerCase(),
        account.toLowerCase(),
    ].join(":");
}

/** Reject malformed/stale storage rather than ever passing arbitrary bigint input to a contract. */
export function parseStoredGameId(value: string | null): bigint | null {
    return value === null ? null : parseGameCode(value);
}
