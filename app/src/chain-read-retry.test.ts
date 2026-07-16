import { describe, expect, it } from "vitest";

import {
    isChainHeadDisjoint,
    retryChainRead,
    withTimeout,
} from "./chain-read-retry";

function disjointError(cause?: unknown): Error {
    const error = new Error("ChainHead disjointed", cause === undefined ? undefined : { cause });
    error.name = "DisjointError";
    return error;
}

describe("ChainHead read retry", () => {
    it("recognizes PAPI's error through a nested cause", () => {
        expect(isChainHeadDisjoint(new Error("outer", { cause: disjointError() }))).toBe(true);
        expect(isChainHeadDisjoint(new Error("ordinary network error"))).toBe(false);
    });

    it("returns a successful read without retrying", async () => {
        let reads = 0;
        const waits: number[] = [];

        await expect(retryChainRead(
            async () => {
                reads += 1;
                return "ready";
            },
            { sleep: async (milliseconds) => { waits.push(milliseconds); } },
        )).resolves.toBe("ready");

        expect(reads).toBe(1);
        expect(waits).toEqual([]);
    });

    it("retries a disjoint read against the new follower", async () => {
        let reads = 0;
        const waits: number[] = [];

        await expect(retryChainRead(
            async () => {
                reads += 1;
                if (reads < 3) throw disjointError();
                return "recovered";
            },
            {
                delays: [2, 4, 8],
                sleep: async (milliseconds) => { waits.push(milliseconds); },
            },
        )).resolves.toBe("recovered");

        expect(reads).toBe(3);
        expect(waits).toEqual([2, 4]);
    });

    it("does not replay a non-disjoint failure", async () => {
        let reads = 0;
        const error = new Error("contract read failed");

        await expect(retryChainRead(
            async () => {
                reads += 1;
                throw error;
            },
            { sleep: async () => undefined },
        )).rejects.toBe(error);

        expect(reads).toBe(1);
    });

    it("surfaces a persistent disjoint error after its bounded retries", async () => {
        let reads = 0;
        const error = disjointError();

        await expect(retryChainRead(
            async () => {
                reads += 1;
                throw error;
            },
            { delays: [1, 2], sleep: async () => undefined },
        )).rejects.toBe(error);

        expect(reads).toBe(3);
    });

    it("bounds a chain read that never settles", async () => {
        await expect(withTimeout(
            new Promise<never>(() => undefined),
            1,
            "Read timed out.",
        )).rejects.toThrow("Read timed out.");
    });
});
