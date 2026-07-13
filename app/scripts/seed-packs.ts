/**
 * Seed starter packs from `shared/packs/*.json` into the deployed Quizzler
 * contract on Paseo Asset Hub.
 *
 * Strategy: per pack — one `createPack` tx, then all `addQuestion` calls
 * dry-run (exact gas + early revert detection) and submitted as individual
 * `Revive.call` extrinsics with manually assigned nonces, in parallel
 * batches, finishing with `sealPack`. Sequential submission of ~2,000 txs
 * would take hours; nonce-parallel batches land ~25 per block-pair.
 *
 * Resume-safe: packs whose title already exists on-chain sealed are skipped;
 * a partially-seeded pack continues from its on-chain `regular_count`, and
 * finals tolerate "already set" reverts.
 *
 * Usage:
 *   pnpm seed:packs                       # dev //Alice
 *   DEPLOY_DEV_ACCOUNT=Bob pnpm seed:packs
 *   SEED_ONLY=03 pnpm seed:packs          # only files starting "03"
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountId, Binary, createClient, type PolkadotSigner } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { createDevSigner, ensureAccountMapped, getDevPublicKey } from "@parity/product-sdk-tx";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { encodeFunctionData, decodeFunctionResult, hexToBytes, type Abi } from "viem";

import abiJson from "../src/abi.json";
import contractInfo from "../src/contract-address.json";
import { normalizeAnswer } from "../src/normalize";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = join(__dirname, "..", "..", "shared", "packs");
const RPC = process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";
const DEV_ACCOUNT = (process.env.DEPLOY_DEV_ACCOUNT ?? "Alice") as Parameters<typeof createDevSigner>[0];
const BATCH = Number(process.env.SEED_BATCH ?? 8);
/** addQuestion calls packed into one Utility.batch_all extrinsic. */
const INNER = Number(process.env.SEED_INNER ?? 16);
const TX_TIMEOUT_MS = 120_000;

const abi = abiJson as Abi;

interface PackQuestion {
    text: string;
    answers: string[];
}
interface PackFile {
    title: string;
    questions: PackQuestion[];
    finals: Record<"easy" | "medium" | "hard", PackQuestion>;
}

function validateQuestion(q: PackQuestion, where: string): void {
    if (!q.text || q.text.length > 256) throw new Error(`${where}: bad text length`);
    if (q.answers.length < 1 || q.answers.length > 5) throw new Error(`${where}: bad answer count`);
    for (const a of q.answers) {
        const norm = normalizeAnswer(a);
        if (!norm || norm.length > 64) throw new Error(`${where}: answer ${JSON.stringify(a)} normalizes to ${JSON.stringify(norm)}`);
    }
}

function bigintReplacer(_k: string, v: unknown): unknown {
    return typeof v === "bigint" ? v.toString() : v;
}

/** Dry-run output data may decode as hex string or bytes depending on codec path. */
function toHex(v: string | Uint8Array): `0x${string}` {
    return (typeof v === "string" ? v : Binary.toHex(v)) as `0x${string}`;
}

function revertText(v: string | Uint8Array): string {
    const bytes = typeof v === "string" ? hexToBytes(v as `0x${string}`) : v;
    return new TextDecoder().decode(bytes);
}

async function main(): Promise<void> {
    if (!contractInfo.address) throw new Error("No contract address — run deploy:contract first");
    // H160 dest must be a lowercase hex STRING for PAPI's dynamic codecs
    // (Uint8Array/FixedSizeBinary fails — see product-sdk wrap.ts); calldata
    // is raw bytes.
    const dest = contractInfo.address.toLowerCase() as `0x${string}`;

    const files = (await readdir(PACKS_DIR)).filter((f) => f.endsWith(".json")).sort();
    const only = process.env.SEED_ONLY;
    const selected = only ? files.filter((f) => f.startsWith(only)) : files;
    console.log(`Seeding ${selected.length} pack file(s) from ${PACKS_DIR}`);

    const client = createClient(getWsProvider(RPC));
    const api = client.getTypedApi(paseo_asset_hub);
    // ReviveApi dry-runs go through the unsafe API: the descriptor package
    // lags the live runtime for ReviveApi_call and fails PAPI's compat check
    // (same workaround the contracts SDK uses in wrap.ts).
    const unsafeApi = client.getUnsafeApi();
    const signer = createDevSigner(DEV_ACCOUNT);
    const address = AccountId(0).dec(getDevPublicKey(DEV_ACCOUNT));
    console.log(`Signing as //${DEV_ACCOUNT} (${address}) on ${RPC}`);

    await ensureAccountMapped(address, signer, {
        addressIsMapped: async (addr: string) =>
            (await api.query.Revive.OriginalAccount.getValue(ss58ToH160(addr))) !== undefined,
    }, api);

    // ── helpers ──────────────────────────────────────────────────

    let nonce = await api.apis.AccountNonceApi.account_nonce(address);
    console.log(`Starting nonce: ${nonce}`);

    async function dryRun(data: `0x${string}`): Promise<{ gas: { ref_time: bigint; proof_size: bigint }; deposit: bigint }> {
        const res: any = await (unsafeApi as any).apis.ReviveApi.call(
            address, dest, 0n, undefined, undefined, hexToBytes(data), { at: "best" },
        );
        if (!res.result.success) {
            const flags = res.result.value;
            throw new Error(`dry-run revert: ${JSON.stringify(flags, bigintReplacer)}`);
        }
        // contract reverts still "succeed" the runtime call with the revert
        // flag set — surface the revert message from the output data
        if (res.result.value.flags !== 0) {
            throw new Error(`contract reverted: ${revertText(res.result.value.data)}`);
        }
        return {
            gas: res.weight_required,
            deposit: res.storage_deposit.type === "Charge" ? res.storage_deposit.value : 0n,
        };
    }

    function reviveCall(data: `0x${string}`, gas: { ref_time: bigint; proof_size: bigint }, deposit: bigint) {
        return api.tx.Revive.call({
            dest,
            value: 0n,
            weight_limit: { ref_time: (gas.ref_time * 15n) / 10n, proof_size: (gas.proof_size * 15n) / 10n },
            storage_deposit_limit: deposit * 2n + 1_000_000_000n,
            data: hexToBytes(data),
        });
    }

    function submitAt(tx: ReturnType<typeof reviveCall>, useNonce: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                sub.unsubscribe();
                reject(new Error(`tx nonce=${useNonce} timed out after ${TX_TIMEOUT_MS / 1000}s`));
            }, TX_TIMEOUT_MS);
            const sub = tx.signSubmitAndWatch(signer, { nonce: useNonce }).subscribe({
                next(ev) {
                    if (ev.type === "txBestBlocksState" && ev.found) {
                        clearTimeout(timer);
                        if (!ev.ok) {
                            reject(new Error(`dispatch error: ${JSON.stringify(ev.dispatchError, bigintReplacer)}`));
                        } else {
                            resolve();
                        }
                        sub.unsubscribe();
                    }
                },
                error(err) {
                    clearTimeout(timer);
                    reject(err);
                    sub.unsubscribe();
                },
            });
        });
    }

    async function query<T>(functionName: string, args: unknown[]): Promise<T> {
        const data = encodeFunctionData({ abi, functionName, args });
        const res: any = await (unsafeApi as any).apis.ReviveApi.call(
            address, dest, 0n, undefined, undefined, hexToBytes(data), { at: "best" },
        );
        if (!res.result.success || res.result.value.flags !== 0) {
            throw new Error(`query ${functionName} reverted`);
        }
        return decodeFunctionResult({
            abi, functionName,
            data: toHex(res.result.value.data),
        }) as T;
    }

    // ── seed each pack ───────────────────────────────────────────

    for (const file of selected) {
        const pack: PackFile = JSON.parse(await readFile(join(PACKS_DIR, file), "utf8"));
        console.log(`\n── ${file}: "${pack.title}" — ${pack.questions.length} questions + finals`);

        pack.questions.forEach((q, i) => validateQuestion(q, `${file} q${i}`));
        (["easy", "medium", "hard"] as const).forEach((d) => validateQuestion(pack.finals[d], `${file} final ${d}`));

        // Find or create the pack on-chain (resume support).
        const packCount = Number(await query<number | bigint>("packCount", []));
        let packId: number | null = null;
        let resumeFrom = 0;
        for (let id = 0; id < packCount; id++) {
            const meta = await query<{ title: string; sealed: boolean; regular_count: number }>("getPack", [id]);
            if (meta.title === pack.title) {
                if (meta.sealed) {
                    packId = -1; // sentinel: fully done
                } else {
                    packId = id;
                    resumeFrom = meta.regular_count;
                }
                break;
            }
        }
        if (packId === -1) {
            console.log("  already sealed on-chain — skipping");
            continue;
        }
        if (packId === null) {
            const data = encodeFunctionData({ abi, functionName: "createPack", args: [pack.title] });
            const { gas, deposit } = await dryRun(data);
            await submitAt(reviveCall(data, gas, deposit), nonce++);
            packId = packCount;
            console.log(`  created pack #${packId}`);
        } else {
            console.log(`  resuming pack #${packId} from question ${resumeFrom}`);
        }

        // Regular questions, then finals (marked with difficulty).
        const regular: `0x${string}`[] = pack.questions.slice(resumeFrom).map((q) =>
            encodeFunctionData({
                abi, functionName: "addQuestion",
                args: [packId, q.text, q.answers, false, 0],
            }),
        );

        // One representative dry-run (largest call) prices gas for the lot.
        if (regular.length > 0) {
            const biggest = regular.reduce((a, b) => (a.length >= b.length ? a : b));
            const { gas, deposit } = await dryRun(biggest);

            // Pack INNER addQuestion calls per Utility.batch_all extrinsic and
            // submit those with parallel nonces — ~2,000 individual txs would
            // otherwise dominate wall-clock time.
            const batchTxs: { label: string; tx: ReturnType<typeof reviveCall> }[] = [];
            for (let i = 0; i < regular.length; i += INNER) {
                const chunk = regular.slice(i, i + INNER);
                const inner = chunk.map((data) => reviveCall(data, gas, deposit).decodedCall);
                batchTxs.push({
                    label: `q${resumeFrom + i}-q${resumeFrom + i + chunk.length - 1}`,
                    tx: api.tx.Utility.batch_all({ calls: inner }) as ReturnType<typeof reviveCall>,
                });
            }
            for (let i = 0; i < batchTxs.length; i += BATCH) {
                const group = batchTxs.slice(i, i + BATCH);
                console.log(`  ${group[0].label} … ${group[group.length - 1].label} (nonces from ${nonce})`);
                const results = await Promise.allSettled(
                    group.map((u) => submitAt(u.tx, nonce++)),
                );
                const failed = results
                    .map((r, j) => ({ r, u: group[j] }))
                    .filter(({ r }) => r.status === "rejected");
                if (failed.length > 0) {
                    for (const { r, u } of failed) {
                        console.error(`  FAILED ${u.label}: ${(r as PromiseRejectedResult).reason}`);
                    }
                    throw new Error(`${failed.length} batch(es) failed in ${file} — rerun to resume`);
                }
            }
            console.log(`  ${regular.length} question(s) submitted`);
        }

        // Finals go individually so an "already set" revert (resume case)
        // can be tolerated without killing a whole batch.
        for (const [d, name] of (["easy", "medium", "hard"] as const).entries()) {
            const data = encodeFunctionData({
                abi, functionName: "addQuestion",
                args: [packId, pack.finals[name].text, pack.finals[name].answers, true, d],
            });
            try {
                const price = await dryRun(data);
                await submitAt(reviveCall(data, price.gas, price.deposit), nonce++);
            } catch (e) {
                if (!/FinalAlreadySet|ContractReverted/.test(String(e))) throw e;
                console.log(`  final:${name} already set — skipping`);
            }
        }

        const sealData = encodeFunctionData({ abi, functionName: "sealPack", args: [packId] });
        const sealPrice = await dryRun(sealData);
        await submitAt(reviveCall(sealData, sealPrice.gas, sealPrice.deposit), nonce++);
        const sealed = await query<{ sealed: boolean; regular_count: number }>("getPack", [packId]);
        console.log(`  sealed=${sealed.sealed} regular_count=${sealed.regular_count} ✓`);
    }

    console.log("\nAll packs seeded.");
    client.destroy();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
