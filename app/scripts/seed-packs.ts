/**
 * Seed starter packs from `shared/packs/*.json` into a Quizzler registry on
 * Paseo Asset Hub.
 *
 * Strategy: per pack — one nonce-addressed `createPackWithNonce` tx, then
 * bounded `addQuestions` calls dry-run (exact gas + early revert detection)
 * and submit as individual `Revive.call` extrinsics with manually assigned
 * nonces, finishing with `sealPack`. Parallel batches keep the starter
 * catalog practical while every contract call remains resumable.
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
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountId, Binary, createClient, type PolkadotSigner } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { createDevSigner, ensureAccountMapped, getDevPublicKey } from "@parity/product-sdk-tx";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { encodeFunctionData, decodeFunctionResult, hexToBytes, type Abi } from "viem";

import { normalizeAcceptedAnswers, validatePack, type PackFile } from "../src/pack-validation";
import { starterPackEmoji, validateStarterPackMetadata } from "./starter-packs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = join(__dirname, "..", "..", "shared", "packs");
const ACTIVE_ADDRESS_FILE = join(__dirname, "..", "src", "contract-address.json");
const ACTIVE_ABI_FILE = join(__dirname, "..", "src", "abi-registry.json");
const RPC = process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";
const DEV_ACCOUNT = (process.env.DEPLOY_DEV_ACCOUNT ?? "Alice") as Parameters<typeof createDevSigner>[0];
const BATCH = positiveEnvInt("SEED_BATCH", 8, 32);
/** Must stay within the registry's bounded `addQuestions` contract batch. */
const QUESTIONS_PER_CALL = 8;
const TX_TIMEOUT_MS = 120_000;
let activeClient: ReturnType<typeof createClient> | null = null;

interface DeploymentTarget {
    registry?: string;
}

interface PackView {
    creator: string;
    title: string;
    emoji: string;
    sealed: boolean;
    regular_count: number;
    finals_set_count: number;
}

interface ExpectedStarterPack {
    file: string;
    pack: PackFile;
    emoji: string;
}

interface QuestionInput {
    text: string;
    answers: string[];
    is_final: boolean;
    difficulty: number;
}

/** Stable per-file nonce makes a rerun resolve its own created pack safely. */
function creationNonceFor(file: string): bigint {
    return createHash("sha256")
        .update("quizzler-starter-pack-v1\0")
        .update(file)
        .digest()
        .readBigUInt64BE(0);
}

function hasPackPublishingApi(abi: Abi): boolean {
    const canCreate = abi.some((entry) =>
        entry.type === "function"
        && entry.name === "createPackWithNonce"
        && entry.inputs.length === 3
        && entry.inputs[0]?.type === "string"
        && entry.inputs[1]?.type === "string"
        && entry.inputs[2]?.type === "uint64",
    );
    const canAdd = abi.some((entry) =>
        entry.type === "function"
        && entry.name === "addQuestions"
        && entry.inputs.length === 2
        && entry.inputs[0]?.type === "uint32"
        && entry.inputs[1]?.type === "tuple[]",
    );
    const canResolve = abi.some((entry) =>
        entry.type === "function"
        && entry.name === "getPackForCreation"
        && entry.inputs.length === 2
        && entry.inputs[0]?.type === "address"
        && entry.inputs[1]?.type === "uint64",
    );
    return canCreate && canAdd && canResolve;
}

async function loadTarget(): Promise<{
    abi: Abi;
    dest: `0x${string}`;
}> {
    const target = JSON.parse(await readFile(ACTIVE_ADDRESS_FILE, "utf8")) as DeploymentTarget;
    const registry = target.registry;
    if (typeof registry !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(registry)) {
        throw new Error(`No valid registry address in ${ACTIVE_ADDRESS_FILE} — deploy it first`);
    }
    const abiRaw = await readFile(ACTIVE_ABI_FILE);
    const abi = JSON.parse(abiRaw.toString("utf8")) as Abi;
    if (!hasPackPublishingApi(abi)) {
        throw new Error(
            `Registry ABI at ${ACTIVE_ABI_FILE} does not support nonce-addressed pack publishing. Build and deploy the current registry first.`,
        );
    }
    return {
        abi,
        dest: registry.toLowerCase() as `0x${string}`,
    };
}

function positiveEnvInt(name: string, fallback: number, max: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number from 1 to ${max}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new Error(`${name} must be a whole number from 1 to ${max}`);
    }
    return value;
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
    const files = (await readdir(PACKS_DIR)).filter((file) => file.endsWith(".json")).sort();
    validateStarterPackMetadata(files);
    const starterPacks: ExpectedStarterPack[] = await Promise.all(files.map(async (file) => {
        const pack = validatePack(
            JSON.parse(await readFile(join(PACKS_DIR, file), "utf8")),
            file,
        );
        return { file, pack, emoji: starterPackEmoji(file, pack.title) };
    }));
    const only = process.env.SEED_ONLY;
    const selected = only ? starterPacks.filter(({ file }) => file.startsWith(only)) : starterPacks;
    if (selected.length === 0) {
        throw new Error(`SEED_ONLY=${JSON.stringify(only)} did not match a starter-pack filename`);
    }
    console.log(`Seeding ${selected.length} pack file(s) from ${PACKS_DIR}`);
    const { abi, dest } = await loadTarget();
    console.log(`Target registry: ${dest}`);

    const client = activeClient = createClient(getWsProvider(RPC));
    const api = client.getTypedApi(paseo_asset_hub);
    // ReviveApi dry-runs go through the unsafe API: the descriptor package
    // lags the live runtime for ReviveApi_call and fails PAPI's compat check
    // (same workaround the contracts SDK uses in wrap.ts).
    const unsafeApi = client.getUnsafeApi();
    const signer = createDevSigner(DEV_ACCOUNT);
    const address = AccountId(0).dec(getDevPublicKey(DEV_ACCOUNT));
    const accountH160 = ss58ToH160(address).toLowerCase();
    console.log(`Signing as //${DEV_ACCOUNT} (${address}) on ${RPC}`);

    await ensureAccountMapped(address, signer, {
        addressIsMapped: async (addr: string) =>
            (await api.query.Revive.OriginalAccount.getValue(ss58ToH160(addr))) !== undefined,
    }, api);

    // ── helpers ──────────────────────────────────────────────────

    // Read best-chain state rather than finalized state. This is especially
    // important when seeding immediately after deployment: finalized address
    // metadata can be written while the account nonce API's default view is
    // still one block behind.
    let nonce = await api.apis.AccountNonceApi.account_nonce(address, { at: "best" });
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

    async function packForCreation(creationNonce: bigint): Promise<number | null> {
        const id = Number(await query<number | bigint>("getPackForCreation", [accountH160, creationNonce]));
        return id === 0xffffffff ? null : id;
    }

    // ── seed each pack ───────────────────────────────────────────

    for (const { file, pack, emoji } of selected) {
        console.log(`\n── ${file}: ${emoji} "${pack.title}" — ${pack.questions.length} questions + finals`);

        const creationNonce = creationNonceFor(file);
        let packId = await packForCreation(creationNonce);

        if (packId === null) {
            const data = encodeFunctionData({
                abi,
                functionName: "createPackWithNonce",
                args: [pack.title, emoji, creationNonce],
            });
            try {
                const { gas, deposit } = await dryRun(data);
                await submitAt(reviveCall(data, gas, deposit), nonce++);
            } catch (error) {
                // A connection can drop after inclusion. Resolve the durable
                // nonce mapping before treating that as a failed creation.
                packId = await packForCreation(creationNonce);
                if (packId === null) throw error;
            }
            packId ??= await packForCreation(creationNonce);
            if (packId === null) throw new Error("could not locate the pack just created");
            console.log(`  created pack #${packId}`);
        }

        const existing = await query<PackView>("getPack", [packId]);
        if (
            existing.creator.toLowerCase() !== accountH160
            || existing.title !== pack.title
            || existing.emoji !== emoji
        ) {
            throw new Error(`pack #${packId} does not match ${file}'s creator, title, or emoji`);
        }
        if (existing.sealed) {
            if (existing.regular_count !== pack.questions.length || existing.finals_set_count !== 3) {
                throw new Error(`sealed pack #${packId} does not match ${file}'s expected question count`);
            }
            console.log("  already sealed on-chain — skipping");
            continue;
        }
        if (existing.regular_count > pack.questions.length) {
            throw new Error(`pack #${packId} has more regular questions than ${file}`);
        }
        const resumeFrom = existing.regular_count;
        if (resumeFrom > 0) console.log(`  resuming pack #${packId} from question ${resumeFrom}`);

        // The registry accepts a bounded, atomic addQuestions chunk. Submit
        // several of those chunks in parallel nonces to keep large starter
        // catalogs practical while retaining a safe resume point per call.
        const regular: QuestionInput[] = pack.questions.slice(resumeFrom).map((question) => ({
            text: question.text,
            answers: normalizeAcceptedAnswers(question.answers),
            is_final: false,
            difficulty: 0,
        }));
        if (regular.length > 0) {
            const batches = Array.from(
                { length: Math.ceil(regular.length / QUESTIONS_PER_CALL) },
                (_, index) => regular.slice(index * QUESTIONS_PER_CALL, (index + 1) * QUESTIONS_PER_CALL),
            );
            const encoded = batches.map((questions, index) => ({
                label: `q${resumeFrom + index * QUESTIONS_PER_CALL}-q${resumeFrom + index * QUESTIONS_PER_CALL + questions.length - 1}`,
                data: encodeFunctionData({ abi, functionName: "addQuestions", args: [packId, questions] }),
            }));
            const biggest = encoded.reduce((left, right) => left.data.length >= right.data.length ? left : right);
            const { gas, deposit } = await dryRun(biggest.data);
            for (let index = 0; index < encoded.length; index += BATCH) {
                const group = encoded.slice(index, index + BATCH);
                console.log(`  ${group[0].label} … ${group[group.length - 1].label} (nonces from ${nonce})`);
                const results = await Promise.allSettled(
                    group.map(({ data }) => submitAt(reviveCall(data, gas, deposit), nonce++)),
                );
                const failed = results
                    .map((result, groupIndex) => ({ result, item: group[groupIndex] }))
                    .filter(({ result }) => result.status === "rejected");
                if (failed.length > 0) {
                    for (const { result, item } of failed) {
                        console.error(`  FAILED ${item.label}: ${(result as PromiseRejectedResult).reason}`);
                    }
                    throw new Error(`${failed.length} addQuestions batch(es) failed in ${file} — rerun to resume`);
                }
            }
            console.log(`  ${regular.length} question(s) submitted`);
        }

        // Finals go individually so an "already set" revert (resume case)
        // can be tolerated without killing a whole batch.
        for (const [d, name] of (["easy", "medium", "hard"] as const).entries()) {
            const data = encodeFunctionData({
                abi,
                functionName: "addQuestions",
                args: [packId, [{
                    text: pack.finals[name].text,
                    answers: normalizeAcceptedAnswers(pack.finals[name].answers),
                    is_final: true,
                    difficulty: d,
                } satisfies QuestionInput]],
            });
            try {
                const price = await dryRun(data);
                await submitAt(reviveCall(data, price.gas, price.deposit), nonce++);
            } catch (e) {
                if (!String(e).includes("FinalAlreadySet")) throw e;
                console.log(`  final:${name} already set — skipping`);
            }
        }

        const sealData = encodeFunctionData({ abi, functionName: "sealPack", args: [packId] });
        const sealPrice = await dryRun(sealData);
        await submitAt(reviveCall(sealData, sealPrice.gas, sealPrice.deposit), nonce++);
        const sealed = await query<PackView>("getPack", [packId]);
        if (
            !sealed.sealed
            || sealed.emoji !== emoji
            || sealed.regular_count !== pack.questions.length
            || sealed.finals_set_count !== 3
        ) {
            throw new Error(`pack #${packId} did not seal with the expected content`);
        }
        console.log(`  sealed=${sealed.sealed} regular_count=${sealed.regular_count} ✓`);
    }

    console.log(`\n${only ? "Selected" : "All"} packs seeded.`);
    client.destroy();
    activeClient = null;
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    activeClient?.destroy();
});
