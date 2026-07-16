/**
 * A ChainHead follower can be replaced underneath an in-flight read. PAPI
 * correctly rejects that old operation with DisjointError while it starts a
 * fresh follower. Contract reads are idempotent, so retry the read after the
 * new follower has had a moment to come online.
 *
 * Keep this helper deliberately narrow: it is not appropriate for signed
 * transactions, transaction watches, or any operation with side effects.
 */

export const CHAIN_READ_RETRY_DELAYS_MS = [250, 500, 1_000] as const;

type ErrorLike = {
    name?: unknown;
    message?: unknown;
    cause?: unknown;
    errors?: unknown;
};

function nestedErrors(error: unknown): Iterable<unknown> {
    if (typeof error !== "object" || error === null) return [];
    const candidate = error as ErrorLike;
    const nested: unknown[] = [];
    if (candidate.cause !== undefined) nested.push(candidate.cause);
    if (Array.isArray(candidate.errors)) nested.push(...candidate.errors);
    return nested;
}

/** True only for PAPI's recoverable ChainHead-follow interruption. */
export function isChainHeadDisjoint(error: unknown): boolean {
    const pending: unknown[] = [error];
    const seen = new Set<object>();
    while (pending.length > 0) {
        const candidate = pending.shift();
        if (typeof candidate !== "object" || candidate === null) continue;
        if (seen.has(candidate)) continue;
        seen.add(candidate);

        const details = candidate as ErrorLike;
        if (details.name === "DisjointError") return true;
        for (const nested of nestedErrors(candidate)) pending.push(nested);
    }
    return false;
}

export type ChainReadRetryOptions = {
    delays?: readonly number[];
    sleep?: (milliseconds: number) => Promise<void>;
};

function defaultSleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Retry a side-effect-free chain read when its ChainHead follower is replaced. */
export async function retryChainRead<T>(
    read: () => Promise<T>,
    { delays = CHAIN_READ_RETRY_DELAYS_MS, sleep = defaultSleep }: ChainReadRetryOptions = {},
): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await read();
        } catch (error) {
            if (!isChainHeadDisjoint(error) || attempt >= delays.length) throw error;
            await sleep(delays[attempt]);
        }
    }
}

/**
 * Bound an external read that can otherwise hang without throwing. The
 * original operation continues in the background, but callers are released
 * to retry or fall back instead of retaining stale UI indefinitely.
 */
export function withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    message = "Timed out reading the chain.",
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        void operation.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}
