/**
 * A second game participant driven directly against the contract from Node.
 * The test host fixture drives a single page, so multi-player specs pair the
 * UI player (bob) with this scripted player (charlie by default), who signs
 * real transactions with a funded dev keypair.
 */

import { AccountId, Binary, createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { createDevSigner, ensureAccountMapped, getDevPublicKey } from "@parity/product-sdk-tx";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionData, hexToBytes, type Abi } from "viem";

import { PASEO_AH } from "./fixtures";

// Read as files: Playwright's ESM loader rejects bare JSON imports.
const registryAbi = JSON.parse(
    readFileSync(new URL("../src/abi-registry.json", import.meta.url), "utf8"),
) as Abi;
const gameAbi = JSON.parse(
    readFileSync(new URL("../src/abi-game.json", import.meta.url), "utf8"),
) as Abi;
const contractInfo = JSON.parse(
    readFileSync(new URL("../src/contract-address.json", import.meta.url), "utf8"),
) as { registry: string; game: string };

/** Methods served by the pack registry; everything else is the game. */
const REGISTRY_METHODS = new Set([
    "createPack", "addQuestion", "sealPack", "packCount", "getPack",
    "getPackStatus", "getQuestion", "getAnswers", "myLatestPack",
]);

function route(functionName: string): { abi: Abi; dest: `0x${string}` } {
    return REGISTRY_METHODS.has(functionName)
        ? { abi: registryAbi, dest: contractInfo.registry.toLowerCase() as `0x${string}` }
        : { abi: gameAbi, dest: contractInfo.game.toLowerCase() as `0x${string}` };
}

const STAGE = {
    LOBBY: 0, ANSWER: 1, REVIEW: 2, VOTE: 3,
    FINAL_ANSWER: 4, FINAL_REVIEW: 5, FINISHED: 6,
} as const;

export interface PhaseView {
    stage: number;
    cursor: number;
    final_difficulty: number;
    player_count: number;
    submit_count: number;
    continue_count: number;
}

export class ScriptedPlayer {
    /**
     * Manually tracked nonce. PAPI derives nonces from finalized state, so
     * back-to-back txs collide (`Invalid: Stale`) whenever finality lags —
     * track locally like the seeding script does.
     */
    private nonce = 0;

    private constructor(
        private client: PolkadotClient,
        private api: any,
        private signer: ReturnType<typeof createDevSigner>,
        readonly ss58: string,
        readonly h160: string,
    ) {}

    static async connect(dev: Parameters<typeof createDevSigner>[0] = "Charlie"): Promise<ScriptedPlayer> {
        if (!contractInfo.registry || !contractInfo.game) {
            throw new Error("contract-address.json is empty — deploy first");
        }
        const client = createClient(getWsProvider(PASEO_AH.rpcUrl));
        const api = client.getTypedApi(paseo_asset_hub);
        const signer = createDevSigner(dev);
        const ss58 = AccountId(0).dec(getDevPublicKey(dev));
        const player = new ScriptedPlayer(client, api, signer, ss58, ss58ToH160(ss58).toLowerCase());
        await ensureAccountMapped(ss58, signer, {
            addressIsMapped: async (addr: string) =>
                (await api.query.Revive.OriginalAccount.getValue(ss58ToH160(addr))) !== undefined,
        }, api);
        player.nonce = await api.apis.AccountNonceApi.account_nonce(ss58, { at: "best" });
        return player;
    }

    destroy(): void {
        this.client.destroy();
    }

    async query<T>(functionName: string, args: unknown[]): Promise<T> {
        const { abi, dest } = route(functionName);
        const data = encodeFunctionData({ abi, functionName, args });
        // unsafe API: descriptor lags the live runtime for ReviveApi_call
        const res: any = await (this.client.getUnsafeApi() as any).apis.ReviveApi.call(
            this.ss58, dest, 0n, undefined, undefined, hexToBytes(data), { at: "best" },
        );
        if (!res.result.success || res.result.value.flags !== 0) {
            throw new Error(`query ${functionName} reverted`);
        }
        return decodeFunctionResult({
            abi, functionName,
            data: toHex(res.result.value.data),
        }) as T;
    }

    async tx(functionName: string, args: unknown[], retried = false): Promise<void> {
        const { abi, dest } = route(functionName);
        const data = encodeFunctionData({ abi, functionName, args });
        const res: any = await (this.client.getUnsafeApi() as any).apis.ReviveApi.call(
            this.ss58, dest, 0n, undefined, undefined, hexToBytes(data), { at: "best" },
        );
        if (!res.result.success) {
            throw new Error(`${functionName} dry-run failed: ${JSON.stringify(res.result.value, br)}`);
        }
        if (res.result.value.flags !== 0) {
            const raw = res.result.value.data;
            const bytes = typeof raw === "string" ? hexToBytes(raw as `0x${string}`) : raw;
            const reason = new TextDecoder().decode(bytes);
            // After a reorg-retry, "Already*" means the original tx landed
            // on the surviving fork — the operation is complete.
            if (retried && /^Already/.test(reason)) return;
            throw new Error(`${functionName} reverted: ${reason}`);
        }
        const tx = this.api.tx.Revive.call({
            dest,
            value: 0n,
            weight_limit: {
                ref_time: (res.weight_required.ref_time * 15n) / 10n,
                proof_size: (res.weight_required.proof_size * 15n) / 10n,
            },
            storage_deposit_limit:
                (res.storage_deposit.type === "Charge" ? res.storage_deposit.value : 0n) * 2n + 1_000_000_000n,
            data: hexToBytes(data),
        });
        // Resolve at best-block: awaiting finality (~15s/tx here) across the
        // ~15 txs a game takes would blow the test budget.
        const useNonce = this.nonce++;
        try {
            await this.submitAt(functionName, tx, useNonce);
        } catch (e) {
            // Dispatch reverts after a clean dry-run are reorg races (state
            // shifted between fork views) — settle and go through the dry-run
            // again, which either confirms completion (Already*) or retries.
            if (retried || !/ContractReverted/.test(String(e))) throw e;
            await new Promise((r) => setTimeout(r, 4_000));
            return this.tx(functionName, args, true);
        }
    }

    private submitAt(functionName: string, tx: any, useNonce: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                sub.unsubscribe();
                reject(new Error(`${functionName} timed out waiting for best block`));
            }, 90_000);
            const sub = tx.signSubmitAndWatch(this.signer, { nonce: useNonce }).subscribe({
                next: (ev: any) => {
                    if (ev.type === "txBestBlocksState" && ev.found) {
                        clearTimeout(timer);
                        if (!ev.ok) {
                            reject(new Error(`${functionName} dispatch error: ${JSON.stringify(ev.dispatchError, br)}`));
                        } else {
                            resolve();
                        }
                        sub.unsubscribe();
                    }
                },
                error: (err: unknown) => {
                    clearTimeout(timer);
                    reject(err);
                    sub.unsubscribe();
                },
            });
        });
    }

    /** Newest pack this player created (ids shift under reorgs). */
    private async resolveMyPack(): Promise<number> {
        const id = Number(await this.query<number | bigint>("myLatestPack", [this.h160]));
        if (id === 0xffffffff) throw new Error("could not locate created test pack");
        return id;
    }

    /** Create + seal a tiny pack this player knows the answers to. */
    async createTestPack(title: string, question: { text: string; answers: string[] }): Promise<number> {
        await this.tx("createPack", [title]);
        // Resolve the id AFTER creation (pre-reading the counter races with
        // concurrent creators), and re-resolve + retry when a best-block
        // reorg shifts the id under us mid-flow (surfaces as a revert).
        let packId = await this.resolveMyPack();
        const onPack = async (fn: string, args: (id: number) => unknown[]): Promise<void> => {
            try {
                await this.tx(fn, args(packId));
            } catch (e) {
                if (!/revert/i.test(String(e))) throw e;
                packId = await this.resolveMyPack();
                await this.tx(fn, args(packId));
            }
        };
        await onPack("addQuestion", (id) => [id, question.text, question.answers, false, 0]);
        await onPack("addQuestion", (id) => [id, "Final (easy): what is 2 plus 2?", ["4"], true, 0]);
        await onPack("addQuestion", (id) => [id, "Final (medium): what is 6 times 7?", ["42"], true, 1]);
        await onPack("addQuestion", (id) => [id, "Final (hard): what is 17 squared?", ["289"], true, 2]);
        await onPack("sealPack", (id) => [id]);
        return packId;
    }

    async getPhase(gameId: bigint): Promise<PhaseView> {
        return this.query<PhaseView>("getPhase", [gameId]);
    }

    /**
     * Play the whole game with a fixed strategy, polling the chain. Resolves
     * when the game reaches Finished. `answer` is what we submit for every
     * regular/final question (pass a wrong answer to exercise overturns).
     */
    async playUntilFinished(gameId: bigint, opts: {
        answer: string;
        wager?: number;
        finalWager?: number;
        difficultyVote?: number;
        onStage?: (phase: PhaseView) => void;
    }): Promise<void> {
        const done = new Set<string>();
        const deadline = Date.now() + 480_000;
        for (;;) {
            if (Date.now() > deadline) throw new Error("scripted player timed out waiting for Finished");
            const phase = await this.getPhase(gameId);
            opts.onStage?.(phase);
            const key = `${phase.stage}:${phase.cursor}`;
            try {
                switch (phase.stage) {
                    case STAGE.FINISHED:
                        return;
                    case STAGE.ANSWER:
                        if (!done.has(key)) {
                            await this.tx("submitAnswer", [gameId, opts.answer, opts.wager ?? 5]);
                            done.add(key);
                        }
                        break;
                    case STAGE.FINAL_ANSWER:
                        if (!done.has(key)) {
                            await this.tx("submitAnswer", [gameId, opts.answer, opts.finalWager ?? 0]);
                            done.add(key);
                        }
                        break;
                    case STAGE.REVIEW:
                    case STAGE.FINAL_REVIEW:
                        if (!done.has(key)) {
                            await this.tx("readyContinue", [gameId]);
                            done.add(key);
                        }
                        break;
                    case STAGE.VOTE:
                        if (!done.has(key)) {
                            await this.tx("voteDifficulty", [gameId, opts.difficultyVote ?? 0]);
                            done.add(key);
                        }
                        break;
                }
            } catch (e) {
                // Races with phase transitions surface as reverts (e.g. the
                // stage collapsed between poll and tx) — mark done and move on.
                if (!String(e).includes("reverted")) throw e;
                done.add(key);
            }
            await new Promise((r) => setTimeout(r, 2_000));
        }
    }
}

function br(_k: string, v: unknown): unknown {
    return typeof v === "bigint" ? v.toString() : v;
}

function toHex(v: string | Uint8Array): `0x${string}` {
    return (typeof v === "string" ? v : Binary.toHex(v)) as `0x${string}`;
}
