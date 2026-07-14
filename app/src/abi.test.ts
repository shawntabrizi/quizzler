import { describe, expect, it } from "vitest";
import gameAbi from "./abi-game.json";
import registryAbi from "./abi-registry.json";

type AbiItem = {
    type: string;
    name?: string;
    inputs?: unknown[];
    outputs?: unknown[];
    stateMutability?: string;
};

function method(abi: AbiItem[], name: string): AbiItem {
    const item = abi.find((candidate) => candidate.type === "function" && candidate.name === name);
    if (!item) throw new Error(`Missing ABI method ${name}`);
    return item;
}

describe("transaction ABI", () => {
    it("exposes immutable emoji metadata when creating and reading a pack", () => {
        const createPack = method(registryAbi as AbiItem[], "createPack");
        expect(createPack.stateMutability).toBe("nonpayable");
        expect(createPack.inputs).toEqual([
            { name: "title", type: "string" },
            { name: "emoji", type: "string" },
        ]);
        expect(createPack.outputs).toEqual([]);

        const getPack = method(registryAbi as AbiItem[], "getPack");
        expect(getPack.outputs).toEqual([
            {
                name: "",
                type: "tuple",
                components: expect.arrayContaining([{ name: "emoji", type: "string" }]),
            },
        ]);
    });

    it("marks game creation as a state-changing call", () => {
        const createGame = method(gameAbi as AbiItem[], "createGame");
        expect(createGame.stateMutability).toBe("nonpayable");
        expect(createGame.outputs).toEqual([]);
    });

    it("exposes the lobby and forfeit lifecycle boundary", () => {
        for (const name of ["leaveLobby", "forfeitGame"]) {
            const lifecycle = method(gameAbi as AbiItem[], name);
            expect(lifecycle.stateMutability).toBe("nonpayable");
            expect(lifecycle.inputs).toEqual([{ name: "game_id", type: "uint64" }]);
        }

        const isPlayerActive = method(gameAbi as AbiItem[], "isPlayerActive");
        expect(isPlayerActive.stateMutability).toBe("view");
        expect(isPlayerActive.outputs).toEqual([{ name: "", type: "bool" }]);

        const getGame = method(gameAbi as AbiItem[], "getGame");
        expect(getGame.outputs).toEqual([
            {
                name: "",
                type: "tuple",
                components: expect.arrayContaining([
                    { name: "active_player_count", type: "uint8" },
                ]),
            },
        ]);

        const getPhase = method(gameAbi as AbiItem[], "getPhase");
        expect(getPhase.outputs).toEqual([
            {
                name: "",
                type: "tuple",
                components: expect.arrayContaining([
                    { name: "active_player_count", type: "uint8" },
                ]),
            },
        ]);

        const getSubmissions = method(gameAbi as AbiItem[], "getSubmissions");
        expect(getSubmissions.outputs).toEqual([
            {
                name: "",
                type: "tuple[]",
                components: expect.arrayContaining([{ name: "active", type: "bool" }]),
            },
        ]);
    });
});
