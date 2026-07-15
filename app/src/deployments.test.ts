import { describe, expect, it } from "vitest";

import { deploymentCatalog, fallbackDeploymentId, resolveDeployment } from "./deployments";

const CURRENT = {
    registry: "0x1111111111111111111111111111111111111111",
    game: "0x2222222222222222222222222222222222222222",
    deploymentId: "paseo-july-2026",
};

describe("known contract deployments", () => {
    it("uses the active pair first and resolves only allowlisted historical pairs", () => {
        const catalog = deploymentCatalog({
            ...CURRENT,
            previousDeployments: [{
                id: "paseo-june-2026",
                registry: "0x3333333333333333333333333333333333333333",
                game: "0x4444444444444444444444444444444444444444",
            }],
        });

        expect(catalog.map((deployment) => deployment.id)).toEqual(["paseo-july-2026", "paseo-june-2026"]);
        expect(resolveDeployment(catalog, "PASEO-JUNE-2026")?.game)
            .toBe("0x4444444444444444444444444444444444444444");
        expect(resolveDeployment(catalog, "https://untrusted.example")).toBeNull();
    });

    it("gives legacy address files a deterministic deployment ID", () => {
        expect(fallbackDeploymentId(CURRENT.game)).toBe("game-222222222222");
        expect(deploymentCatalog(CURRENT)[0]?.id).toBe("paseo-july-2026");
    });
});
