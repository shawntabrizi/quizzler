import { parseGameCode } from "./input";

export const INVITE_QUERY_PARAM = "join";
export const INVITE_DEPLOYMENT_QUERY_PARAM = "d";

export interface SharedLobbyInvite {
    present: boolean;
    gameId: bigint | null;
    deploymentId: string | null;
    cleanedUrl: string;
}

/** Read one invite from a URL and return its equivalent without `?join=`. */
export function consumeSharedLobbyInvite(urlString: string): SharedLobbyInvite {
    const url = new URL(urlString);
    const raw = url.searchParams.get(INVITE_QUERY_PARAM);
    const deploymentId = url.searchParams.get(INVITE_DEPLOYMENT_QUERY_PARAM);
    url.searchParams.delete(INVITE_QUERY_PARAM);
    url.searchParams.delete(INVITE_DEPLOYMENT_QUERY_PARAM);
    return {
        present: raw !== null,
        gameId: raw === null ? null : parseGameCode(raw),
        deploymentId,
        cleanedUrl: url.toString(),
    };
}

/** Create an invite while preserving player-facing product URL parameters. */
export function sharedLobbyInviteUrl(urlString: string, gameId: bigint, deploymentId?: string): string {
    const url = new URL(urlString);
    // This is a test-only catalog switch, never part of a player invite.
    url.searchParams.delete("show-test-packs");
    url.searchParams.set(INVITE_QUERY_PARAM, gameId.toString());
    if (deploymentId) url.searchParams.set(INVITE_DEPLOYMENT_QUERY_PARAM, deploymentId);
    else url.searchParams.delete(INVITE_DEPLOYMENT_QUERY_PARAM);
    return url.toString();
}
