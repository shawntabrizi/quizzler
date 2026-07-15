/**
 * Non-secret local policy for automatic session setup.
 *
 * A session key itself is stored only in host KV. This record merely prevents
 * a declined or unsupported host from showing the same allowance request on
 * every new lobby.
 */
export interface InstantPlayPreference {
    /** The player explicitly chose normal wallet signatures until retrying. */
    mode?: "manual";
    /** Temporary retry gate for host/RPC failures. */
    retryAfter?: number;
}

export const TEMPORARY_INSTANT_PLAY_RETRY_MS = 30 * 60_000;

export function normalizeInstantPlayPreference(value: unknown): InstantPlayPreference | null {
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as { mode?: unknown; retryAfter?: unknown };
    const mode = candidate.mode === "manual" ? "manual" : undefined;
    const retryAfter = typeof candidate.retryAfter === "number"
        && Number.isFinite(candidate.retryAfter)
        && candidate.retryAfter > 0
        ? candidate.retryAfter
        : undefined;
    return mode || retryAfter ? { mode, retryAfter } : null;
}

export function automaticInstantPlayAllowed(
    preference: InstantPlayPreference | null,
    now = Date.now(),
): boolean {
    return preference?.mode !== "manual" && (preference?.retryAfter === undefined || preference.retryAfter <= now);
}

export function temporaryInstantPlayFailure(
    now = Date.now(),
): InstantPlayPreference {
    return { retryAfter: now + TEMPORARY_INSTANT_PLAY_RETRY_MS };
}
