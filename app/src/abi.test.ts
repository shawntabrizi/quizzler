import { describe, expect, it } from "vitest";
import gameAbi from "./abi-game.json";
import registryAbi from "./abi-registry.json";

type AbiItem = { type: string; name?: string; outputs?: unknown[]; stateMutability?: string };

function method(abi: AbiItem[], name: string): AbiItem {
    const item = abi.find((candidate) => candidate.type === "function" && candidate.name === name);
    if (!item) throw new Error(`Missing ABI method ${name}`);
    return item;
}

describe("transaction ABI", () => {
    it("marks pack creation as a state-changing call", () => {
        const createPack = method(registryAbi as AbiItem[], "createPack");
        expect(createPack.stateMutability).toBe("nonpayable");
        expect(createPack.outputs).toEqual([]);
    });

    it("marks game creation as a state-changing call", () => {
        const createGame = method(gameAbi as AbiItem[], "createGame");
        expect(createGame.stateMutability).toBe("nonpayable");
        expect(createGame.outputs).toEqual([]);
    });
});
