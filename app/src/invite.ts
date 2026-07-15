import { parseGameCode } from "./input";

export const INVITE_QUERY_PARAM = "join";

export interface SharedLobbyInvite {
    present: boolean;
    gameId: bigint | null;
    cleanedUrl: string;
}

/** Read one invite from a URL and return its equivalent without `?join=`. */
export function consumeSharedLobbyInvite(urlString: string): SharedLobbyInvite {
    const url = new URL(urlString);
    const raw = url.searchParams.get(INVITE_QUERY_PARAM);
    url.searchParams.delete(INVITE_QUERY_PARAM);
    // `d` was a historical deployment selector. A fresh release has one
    // contract pair, so discard it when cleaning an old shared URL.
    url.searchParams.delete("d");
    return {
        present: raw !== null,
        gameId: raw === null ? null : parseGameCode(raw),
        cleanedUrl: url.toString(),
    };
}

/** Create an invite while preserving player-facing product URL parameters. */
export function sharedLobbyInviteUrl(urlString: string, gameId: bigint): string {
    const url = new URL(urlString);
    // This is a test-only catalog switch, never part of a player invite.
    url.searchParams.delete("show-test-packs");
    url.searchParams.delete("d");
    url.searchParams.set(INVITE_QUERY_PARAM, gameId.toString());
    return url.toString();
}
