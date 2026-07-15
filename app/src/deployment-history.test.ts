import { describe, expect, it } from "vitest";
import { deploymentIdForGame, promoteDeploymentConfig } from "./deployment-history";

const registry = "0x1111111111111111111111111111111111111111";
const oldGame = "0x2222222222222222222222222222222222222222";
const newGame = "0x3333333333333333333333333333333333333333";

describe("deployment history", () => {
    it("keeps the prior pair as a bounded, explicit invite and resume allowlist", () => {
        const promoted = promoteDeploymentConfig(
            { registry, game: oldGame, deploymentId: "paseo-old", deployedAt: "2026-01-01T00:00:00.000Z" },
            { registry, game: newGame, deployedAt: "2026-02-01T00:00:00.000Z" },
        );

        expect(promoted.deploymentId).toBe(deploymentIdForGame(newGame));
        expect(promoted.previousDeployments).toEqual([
            { id: "paseo-old", registry, game: oldGame, deployedAt: "2026-01-01T00:00:00.000Z" },
        ]);
    });

    it("does not retain duplicate IDs or address pairs", () => {
        const promoted = promoteDeploymentConfig(
            {
                registry,
                game: oldGame,
                deploymentId: "same-pair",
                previousDeployments: [
                    { id: "duplicate-id", registry, game: oldGame },
                    { id: "same-pair", registry, game: newGame },
                ],
            },
            { registry, game: newGame, id: "duplicate-id" },
        );

        expect(promoted.previousDeployments).toEqual([
            { id: "same-pair", registry, game: oldGame },
        ]);
    });
});
