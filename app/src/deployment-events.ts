/** A concrete H160 emitted by pallet-revive after a successful instantiation. */
export type ContractAddress = `0x${string}`;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function isContractAddress(value: unknown): value is ContractAddress {
    return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Return the one contract address emitted by an `instantiate_with_code`
 * extrinsic. PAPI normally flattens System.Events, while direct event reads
 * keep the event under `.event`, so support both representations.
 *
 * A dry-run address is deliberately not a fallback: its result is tied to a
 * particular best-chain state and can become stale on a reorg. The finalized
 * event is the canonical source of the durable deployment address.
 */
export function instantiatedContractAddress(events: readonly unknown[]): ContractAddress {
    const addresses: ContractAddress[] = [];

    for (const raw of events) {
        const outer = asRecord(raw);
        if (!outer) continue;
        const event = asRecord(outer.event) ?? outer;
        if (event.type !== "Revive") continue;

        const variant = asRecord(event.value);
        if (variant?.type !== "Instantiated") continue;

        const payload = asRecord(variant.value);
        if (!isContractAddress(payload?.contract)) {
            throw new Error("Revive.Instantiated did not contain a valid contract address.");
        }
        addresses.push(payload.contract.toLowerCase() as ContractAddress);
    }

    if (addresses.length !== 1) {
        throw new Error(
            `Deployment finalized without exactly one Revive.Instantiated event (found ${addresses.length}); refusing to use a dry-run-predicted address.`,
        );
    }
    return addresses[0]!;
}
