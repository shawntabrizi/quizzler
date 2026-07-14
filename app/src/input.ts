/** Small, shared input guards for values that will be ABI-encoded as integers. */
export function parseIntegerInRange(raw: string, min: number, max: number): number | null {
    const value = raw.trim();
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/** Game ids are deliberately six-digit, non-sequential join codes. */
export function parseGameCode(raw: string): bigint | null {
    const value = parseIntegerInRange(raw, 100_000, 999_999);
    return value === null ? null : BigInt(value);
}

/** Contract limits are byte limits, not JavaScript UTF-16 code-unit limits. */
export function utf8ByteLength(value: string): number {
    return new TextEncoder().encode(value).length;
}
