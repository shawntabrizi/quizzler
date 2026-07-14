/**
 * Seed starter packs from `shared/packs/*.json` into a Quizzler registry on
 * Paseo Asset Hub.
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
 *   pnpm seed:registry-migration           # seed the staged fresh registry
 */

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountId, Binary, createClient, type PolkadotSigner } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { createDevSigner, ensureAccountMapped, getDevPublicKey } from "@parity/product-sdk-tx";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { encodeFunctionData, decodeFunctionResult, hexToBytes, type Abi } from "viem";

import { normalizeAcceptedAnswers, validatePack, type PackFile } from "../src/pack-validation";
import { starterCatalogFingerprint } from "./catalog-fingerprint";
import { starterPackEmoji, validateStarterPackMetadata } from "./starter-packs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = join(__dirname, "..", "..", "shared", "packs");
const ACTIVE_ADDRESS_FILE = join(__dirname, "..", "src", "contract-address.json");
const ACTIVE_ABI_FILE = join(__dirname, "..", "src", "abi-registry.json");
const MIGRATION_FILE = join(__dirname, "..", ".quizzler-registry-migration.json");
const MIGRATION_ABI_FILE = join(__dirname, "..", "..", "contracts", "registry", "target", "quizzler-registry.release.abi.json");
const MIGRATION_CODE_FILE = join(__dirname, "..", "..", "contracts", "registry", "target", "quizzler-registry.release.polkavm");
const RPC = process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";
const DEV_ACCOUNT = (process.env.DEPLOY_DEV_ACCOUNT ?? "Alice") as Parameters<typeof createDevSigner>[0];
const BATCH = positiveEnvInt("SEED_BATCH", 8, 32);
/** addQuestion calls packed into one Utility.batch_all extrinsic. */
const INNER = positiveEnvInt("SEED_INNER", 16, 32);
const TX_TIMEOUT_MS = 120_000;
const SEED_REGISTRY_MIGRATION = process.env.SEED_REGISTRY_MIGRATION === "1";

interface DeploymentTarget {
    registry?: string;
    deployer?: string;
    migration?: {
        kind?: string;
        status?: string;
        starterPacksSeededAt?: string | null;
        starterPackFiles?: string[];
        catalogSha256?: string;
        artifacts?: {
            registryAbiSha256?: string;
            registryCodeSha256?: string;
            gameAbiSha256?: string;
            gameCodeSha256?: string;
        };
    };
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

function pathFromEnv(name: string, fallback: string): string {
    const value = process.env[name];
    if (!value) return fallback;
    return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function sha256(contents: Uint8Array): string {
    return createHash("sha256").update(contents).digest("hex");
}

function hasEmojiCreatePack(abi: Abi): boolean {
    return abi.some((entry) =>
        entry.type === "function"
        && entry.name === "createPack"
        && entry.inputs.length === 2
        && entry.inputs[0]?.type === "string"
        && entry.inputs[1]?.type === "string",
    );
}

async function loadTarget(): Promise<{
    abi: Abi;
    dest: `0x${string}`;
    expectedSeeder?: string;
    stateFile?: string;
}> {
    const defaultAddressFile = SEED_REGISTRY_MIGRATION ? MIGRATION_FILE : ACTIVE_ADDRESS_FILE;
    const defaultAbiFile = SEED_REGISTRY_MIGRATION ? MIGRATION_ABI_FILE : ACTIVE_ABI_FILE;
    const addressFile = pathFromEnv("SEED_ADDRESS_FILE", defaultAddressFile);
    const abiFile = pathFromEnv("SEED_ABI_FILE", defaultAbiFile);
    const target = JSON.parse(await readFile(addressFile, "utf8")) as DeploymentTarget;
    if (!target.registry) throw new Error(`No registry address in ${addressFile} — deploy it first`);
    if (
        SEED_REGISTRY_MIGRATION
        && (
            target.migration?.kind !== "fresh-registry"
            || (target.migration.status !== "deployed" && target.migration.status !== "seeded")
        )
    ) {
        throw new Error(`${addressFile} is not a fully deployed fresh registry migration state file`);
    }
    if (SEED_REGISTRY_MIGRATION && !/^0x[0-9a-fA-F]{40}$/.test(target.deployer ?? "")) {
        throw new Error(`${addressFile} has no valid migration deployer address`);
    }
    const abiRaw = await readFile(abiFile);
    if (SEED_REGISTRY_MIGRATION) {
        const codeRaw = await readFile(MIGRATION_CODE_FILE);
        if (
            target.migration?.artifacts?.registryAbiSha256 !== sha256(abiRaw)
            || target.migration.artifacts.registryCodeSha256 !== sha256(codeRaw)
        ) {
            throw new Error(
                `Registry artifacts no longer match the staged deployment. Rebuild/re-stage before seeding.`,
            );
        }
    }
    const abi = JSON.parse(abiRaw.toString("utf8")) as Abi;
    if (!hasEmojiCreatePack(abi)) {
        throw new Error(
            `Registry ABI at ${abiFile} does not support createPack(title, emoji). Build the upgraded registry first.`,
        );
    }
    return {
        abi,
        dest: target.registry.toLowerCase() as `0x${string}`,
        expectedSeeder: SEED_REGISTRY_MIGRATION ? target.deployer?.toLowerCase() : undefined,
        stateFile: SEED_REGISTRY_MIGRATION ? addressFile : undefined,
    };
}

async function markMigrationSeeded(
    stateFile: string,
    dest: `0x${string}`,
    files: readonly string[],
    catalogSha256: string,
): Promise<void> {
    const state = JSON.parse(await readFile(stateFile, "utf8")) as DeploymentTarget;
    if (
        state.registry?.toLowerCase() !== dest
        || state.migration?.kind !== "fresh-registry"
        || (state.migration.status !== "deployed" && state.migration.status !== "seeded")
    ) {
        throw new Error(`migration state changed while seeding; refusing to mark ${stateFile} ready`);
    }
    state.migration = {
        ...state.migration,
        status: "seeded",
        starterPacksSeededAt: new Date().toISOString(),
        starterPackFiles: [...files],
        catalogSha256,
    };
    await writeFile(stateFile, `${JSON.stringify(state, null, 4)}\n`);
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
    const catalog = await starterCatalogFingerprint();
    const files = catalog.files;
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
    const { abi, dest, expectedSeeder, stateFile } = await loadTarget();
    console.log(`Target registry: ${dest}${SEED_REGISTRY_MIGRATION ? " (staged migration)" : ""}`);

    const client = createClient(getWsProvider(RPC));
    const api = client.getTypedApi(paseo_asset_hub);
    // ReviveApi dry-runs go through the unsafe API: the descriptor package
    // lags the live runtime for ReviveApi_call and fails PAPI's compat check
    // (same workaround the contracts SDK uses in wrap.ts).
    const unsafeApi = client.getUnsafeApi();
    const signer = createDevSigner(DEV_ACCOUNT);
    const address = AccountId(0).dec(getDevPublicKey(DEV_ACCOUNT));
    const accountH160 = ss58ToH160(address).toLowerCase();
    console.log(`Signing as //${DEV_ACCOUNT} (${address}) on ${RPC}`);
    if (expectedSeeder && expectedSeeder !== accountH160) {
        throw new Error(
            `The staged migration was deployed by ${expectedSeeder}. Re-run with the same DEPLOY_DEV_ACCOUNT to avoid duplicate starter packs.`,
        );
    }

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

    async function myLatestPack(): Promise<number> {
        const id = Number(await query<number | bigint>("myLatestPack", [accountH160]));
        if (id === 0xffffffff) throw new Error("could not locate the pack just created");
        return id;
    }

    // ── seed each pack ───────────────────────────────────────────

    for (const { file, pack, emoji } of selected) {
        console.log(`\n── ${file}: ${emoji} "${pack.title}" — ${pack.questions.length} questions + finals`);

        // Find or create this account's pack by title (resume support). A
        // stranger's same-titled pack must never make us skip or mutate data.
        const packCount = Number(await query<number | bigint>("packCount", []));
        let packId: number | null = null;
        let resumeFrom = 0;
        for (let id = 0; id < packCount; id++) {
            const meta = await query<PackView>("getPack", [id]);
            if (meta.creator.toLowerCase() === accountH160 && meta.title === pack.title) {
                if (meta.emoji !== emoji) {
                    throw new Error(
                        `pack #${id} has emoji ${JSON.stringify(meta.emoji)} but ${file} requires ${JSON.stringify(emoji)}`,
                    );
                }
                if (meta.sealed) {
                    if (meta.regular_count !== pack.questions.length || meta.finals_set_count !== 3) {
                        throw new Error(`sealed pack #${id} does not match ${file}'s expected question count`);
                    }
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
            const data = encodeFunctionData({ abi, functionName: "createPack", args: [pack.title, emoji] });
            const { gas, deposit } = await dryRun(data);
            await submitAt(reviveCall(data, gas, deposit), nonce++);
            packId = await myLatestPack();
            const created = await query<PackView>("getPack", [packId]);
            if (
                created.creator.toLowerCase() !== accountH160
                || created.title !== pack.title
                || created.emoji !== emoji
                || created.sealed
            ) {
                throw new Error(`created pack #${packId} could not be verified`);
            }
            console.log(`  created pack #${packId}`);
        } else {
            console.log(`  resuming pack #${packId} from question ${resumeFrom}`);
        }

        // Regular questions, then finals (marked with difficulty).
        const regular: `0x${string}`[] = pack.questions.slice(resumeFrom).map((q) =>
            encodeFunctionData({
                abi, functionName: "addQuestion",
                args: [packId, q.text, normalizeAcceptedAnswers(q.answers), false, 0],
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
                args: [packId, pack.finals[name].text, normalizeAcceptedAnswers(pack.finals[name].answers), true, d],
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

    async function assertCleanStarterCatalog(): Promise<void> {
        const packCount = Number(await query<number | bigint>("packCount", []));
        if (packCount !== starterPacks.length) {
            throw new Error(
                `fresh registry contains ${packCount} packs; expected exactly the ${starterPacks.length} canonical starter packs`,
            );
        }
        for (const [id, expected] of starterPacks.entries()) {
            const actual = await query<PackView>("getPack", [id]);
            if (
                actual.creator.toLowerCase() !== accountH160
                || actual.title !== expected.pack.title
                || actual.emoji !== expected.emoji
                || !actual.sealed
                || actual.regular_count !== expected.pack.questions.length
                || actual.finals_set_count !== 3
            ) {
                throw new Error(`pack #${id} is not the expected canonical starter pack ${expected.file}`);
            }
        }
        const finalPackCount = Number(await query<number | bigint>("packCount", []));
        if (finalPackCount !== starterPacks.length) {
            throw new Error("registry changed while validating the starter catalog; rerun seeding before promotion");
        }
    }

    if (stateFile && !only) {
        await assertCleanStarterCatalog();
        const finalCatalog = await starterCatalogFingerprint();
        if (finalCatalog.sha256 !== catalog.sha256) {
            throw new Error("starter catalog changed during seeding; refusing to mark this migration ready");
        }
        await markMigrationSeeded(stateFile, dest, files, catalog.sha256);
        console.log(`\nAll packs seeded. Staged migration marked ready in ${stateFile}.`);
        console.log("Next: CONFIRM_PROMOTE_REGISTRY=1 pnpm promote:registry-migration");
    } else if (stateFile) {
        console.log("\nSelected packs seeded. The staged migration is not marked ready while SEED_ONLY is set.");
    } else {
        console.log("\nAll packs seeded.");
    }
    client.destroy();
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
