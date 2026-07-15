import { describe, expect, it } from "vitest";
import gameAbi from "./abi-game.json";
import registryAbi from "./abi-registry.json";
import sessionRegistryAbi from "./abi-session-registry.json";

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
    it("exposes nonce-bound pack creation, batched imports, and immutable emoji metadata", () => {
        const createPack = method(registryAbi as AbiItem[], "createPackWithNonce");
        expect(createPack.stateMutability).toBe("nonpayable");
        expect(createPack.inputs).toEqual([
            { name: "title", type: "string" },
            { name: "emoji", type: "string" },
            { name: "creation_nonce", type: "uint64" },
        ]);
        expect(createPack.outputs).toEqual([]);

        const addQuestions = method(registryAbi as AbiItem[], "addQuestions");
        expect(addQuestions.stateMutability).toBe("nonpayable");
        expect(addQuestions.inputs).toEqual([
            {
                name: "pack_id",
                type: "uint32",
            },
            {
                name: "questions",
                type: "tuple[]",
                components: expect.arrayContaining([
                    { name: "text", type: "string" },
                    { name: "answers", type: "string[]" },
                    { name: "is_final", type: "bool" },
                    { name: "difficulty", type: "uint8" },
                ]),
            },
        ]);

        const getPackForCreation = method(registryAbi as AbiItem[], "getPackForCreation");
        expect(getPackForCreation.stateMutability).toBe("view");
        expect(getPackForCreation.inputs).toEqual([
            { name: "who", type: "address" },
            { name: "creation_nonce", type: "uint64" },
        ]);

        const getPack = method(registryAbi as AbiItem[], "getPack");
        expect(getPack.outputs).toEqual([
            {
                name: "",
                type: "tuple",
                components: expect.arrayContaining([{ name: "emoji", type: "string" }]),
            },
        ]);
    });

    it("marks nonce-bound game creation as a state-changing call", () => {
        const gameConstructor = (gameAbi as AbiItem[]).find((item) => item.type === "constructor");
        expect(gameConstructor?.inputs).toEqual([
            { name: "registry", type: "address" },
            { name: "session_registry", type: "address" },
        ]);

        const sessionRegistry = method(gameAbi as AbiItem[], "sessionRegistry");
        expect(sessionRegistry.stateMutability).toBe("view");
        expect(sessionRegistry.outputs).toEqual([{ name: "", type: "address" }]);

        const createGame = method(gameAbi as AbiItem[], "createGameWithNonce");
        expect(createGame.stateMutability).toBe("nonpayable");
        expect(createGame.inputs).toEqual([
            { name: "pack_id", type: "uint32" },
            { name: "num_questions", type: "uint8" },
            { name: "answer_blocks", type: "uint32" },
            { name: "review_blocks", type: "uint32" },
            { name: "max_players", type: "uint8" },
            { name: "creation_nonce", type: "uint64" },
        ]);
        expect(createGame.outputs).toEqual([]);

        const getGameForCreation = method(gameAbi as AbiItem[], "getGameForCreation");
        expect(getGameForCreation.stateMutability).toBe("view");
        expect(getGameForCreation.inputs).toEqual([
            { name: "who", type: "address" },
            { name: "creation_nonce", type: "uint64" },
        ]);
    });

    it("does not expose superseded creation APIs", () => {
        const registryNames = new Set(
            (registryAbi as AbiItem[])
                .filter((item) => item.type === "function")
                .map((item) => item.name),
        );
        const gameNames = new Set(
            (gameAbi as AbiItem[])
                .filter((item) => item.type === "function")
                .map((item) => item.name),
        );

        for (const name of ["createPack", "addQuestion", "myLatestPack"]) {
            expect(registryNames).not.toContain(name);
        }
        for (const name of ["createGame", "myLatestGame"]) {
            expect(gameNames).not.toContain(name);
        }
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

    it("exposes a locked final-wager phase and live difficulty totals", () => {
        const submitFinalWager = method(gameAbi as AbiItem[], "submitFinalWager");
        expect(submitFinalWager.stateMutability).toBe("nonpayable");
        expect(submitFinalWager.inputs).toEqual([
            { name: "game_id", type: "uint64" },
            { name: "wager", type: "uint32" },
        ]);

        const submitFinalAnswer = method(gameAbi as AbiItem[], "submitFinalAnswer");
        expect(submitFinalAnswer.stateMutability).toBe("nonpayable");
        expect(submitFinalAnswer.inputs).toEqual([
            { name: "game_id", type: "uint64" },
            { name: "answer", type: "string" },
        ]);

        const getPhase = method(gameAbi as AbiItem[], "getPhase");
        expect(getPhase.outputs).toEqual([
            {
                name: "",
                type: "tuple",
                components: expect.arrayContaining([
                    { name: "final_wager_count", type: "uint32" },
                    { name: "easy_vote_count", type: "uint32" },
                    { name: "medium_vote_count", type: "uint32" },
                    { name: "hard_vote_count", type: "uint32" },
                ]),
            },
        ]);

        const getLiveGame = method(gameAbi as AbiItem[], "getLiveGame");
        expect(getLiveGame.outputs).toEqual([
            {
                name: "",
                type: "tuple",
                components: expect.arrayContaining([
                    { name: "difficulty_choices", type: "uint8[]" },
                    { name: "difficulty_vote_locked", type: "bool[]" },
                    { name: "final_wagers", type: "uint32[]" },
                    { name: "final_wager_locked", type: "bool[]" },
                ]),
            },
        ]);
    });

    it("requires session-key possession before enabling instant actions", () => {
        const request = method(sessionRegistryAbi as AbiItem[], "requestSession");
        expect(request.stateMutability).toBe("nonpayable");
        expect(request.inputs).toEqual([{ name: "session", type: "address" }]);

        const activate = method(sessionRegistryAbi as AbiItem[], "activateSession");
        expect(activate.stateMutability).toBe("nonpayable");
        expect(activate.inputs).toEqual([{ name: "owner", type: "address" }]);

        const pending = method(sessionRegistryAbi as AbiItem[], "pendingOwnerOf");
        expect(pending.stateMutability).toBe("view");
        expect(pending.inputs).toEqual([{ name: "session", type: "address" }]);
        expect(pending.outputs).toEqual([{ name: "", type: "address" }]);

        const sessionNames = new Set(
            (sessionRegistryAbi as AbiItem[])
                .filter((item) => item.type === "function")
                .map((item) => item.name),
        );
        expect(sessionNames).not.toContain("registerSession");
    });
});
