/**
 * Verify the active game and pack-signals contracts point at the checked-in
 * pack and session registries.
 *
 * This is deliberately a read-only post-deploy check: it catches an address
 * file/ABI mismatch before a static app is published.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountId, Binary, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { getDevPublicKey } from "@parity/product-sdk-tx";
import { decodeFunctionResult, encodeFunctionData, hexToBytes, type Abi } from "viem";

const appDir = join(fileURLToPath(new URL("..", import.meta.url)));
const addressFile = join(appDir, "src", "contract-address.json");
const gameAbiFile = join(appDir, "src", "abi-game.json");
const packSignalsAbiFile = join(appDir, "src", "abi-pack-signals.json");
const rpc = process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";

interface ContractAddresses {
    registry?: string;
    sessionRegistry?: string;
    packSignals?: string;
    game?: string;
}

function address(value: unknown, label: string): `0x${string}` {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new Error(`Invalid ${label} address in ${addressFile}.`);
    }
    return value.toLowerCase() as `0x${string}`;
}

function outputHex(data: string | Uint8Array): `0x${string}` {
    return (typeof data === "string" ? data : Binary.toHex(data)) as `0x${string}`;
}

async function main(): Promise<void> {
    const [addressRaw, gameAbiRaw, packSignalsAbiRaw] = await Promise.all([
        readFile(addressFile, "utf8"),
        readFile(gameAbiFile, "utf8"),
        readFile(packSignalsAbiFile, "utf8"),
    ]);
    const config = JSON.parse(addressRaw) as ContractAddresses;
    const registry = address(config.registry, "registry");
    const sessionRegistry = address(config.sessionRegistry, "session registry");
    const packSignals = address(config.packSignals, "pack signals");
    const game = address(config.game, "game");
    const gameAbi = JSON.parse(gameAbiRaw) as Abi;
    const packSignalsAbi = JSON.parse(packSignalsAbiRaw) as Abi;
    const caller = AccountId(0).dec(getDevPublicKey("Alice"));
    const client = createClient(getWsProvider(rpc));

    try {
        // The generated descriptor currently lags ReviveApi.call, so use the
        // same safe compatibility path used by the app's live scripts.
        const unsafeApi = client.getUnsafeApi();
        const query = async (
            destination: `0x${string}`,
            abi: Abi,
            contractLabel: string,
            functionName: "registry" | "sessionRegistry",
        ): Promise<string> => {
            const data = encodeFunctionData({ abi, functionName });
            const result: any = await (unsafeApi as any).apis.ReviveApi.call(
                caller,
                destination,
                0n,
                undefined,
                undefined,
                hexToBytes(data),
                { at: "best" },
            );
            if (!result.result.success || result.result.value.flags !== 0) {
                throw new Error(`${contractLabel} ${functionName}() query reverted.`);
            }
            return String(
                decodeFunctionResult({
                    abi,
                    functionName,
                    data: outputHex(result.result.value.data),
                }),
            ).toLowerCase();
        };

        const [gameRegistry, gameSessionRegistry, signalsRegistry, signalsSessionRegistry] = await Promise.all([
            query(game, gameAbi, "Game", "registry"),
            query(game, gameAbi, "Game", "sessionRegistry"),
            query(packSignals, packSignalsAbi, "Pack signals", "registry"),
            query(packSignals, packSignalsAbi, "Pack signals", "sessionRegistry"),
        ]);
        if (
            gameRegistry !== registry ||
            gameSessionRegistry !== sessionRegistry ||
            signalsRegistry !== registry ||
            signalsSessionRegistry !== sessionRegistry
        ) {
            throw new Error(
                "Contract linkage mismatch: " +
                    `game reports registry=${gameRegistry}, sessionRegistry=${gameSessionRegistry}; ` +
                    `pack signals reports registry=${signalsRegistry}, sessionRegistry=${signalsSessionRegistry}.`,
            );
        }
        console.log(`Verified ${game} and ${packSignals}: pack registry and session registry are linked correctly.`);
    } finally {
        client.destroy();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
