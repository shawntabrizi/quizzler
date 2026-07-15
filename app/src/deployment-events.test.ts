import { describe, expect, it } from "vitest";

import { instantiatedContractAddress } from "./deployment-events";

const address = "0x1234567890abcdef1234567890abcdef12345678";

describe("instantiatedContractAddress", () => {
    it("reads PAPI's flattened transaction event", () => {
        expect(instantiatedContractAddress([{
            type: "Revive",
            value: { type: "Instantiated", value: { contract: address } },
        }])).toBe(address);
    });

    it("also reads the unflattened System.Events representation", () => {
        expect(instantiatedContractAddress([{
            event: {
                type: "Revive",
                value: { type: "Instantiated", value: { contract: address } },
            },
        }])).toBe(address);
    });

    it("never falls back to an address predicted by a dry run", () => {
        expect(() => instantiatedContractAddress([
            { type: "System", value: { type: "ExtrinsicSuccess" } },
        ])).toThrow("refusing to use a dry-run-predicted address");
    });
});
