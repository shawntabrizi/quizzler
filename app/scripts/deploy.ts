/**
 * Deploy the Quizzler contract to Paseo Asset Hub via pallet-revive's
 * `instantiate_with_code`, then write the deployed address into
 * `src/contract-address.json` and refresh `src/abi.json`.
 *
 * Usage:
 *   pnpm deploy:contract                # signs with dev //Alice
 *   DEPLOY_DEV_ACCOUNT=Bob pnpm deploy:contract
 *   PASEO_AH_RPC=wss://… pnpm deploy:contract
 *
 * The signing account must hold PAS. Build the contract first:
 *   cd ../contracts/quizzler && cargo pvm-contract build
 */

import { copyFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountId, Binary, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { loadPvmContractArtifacts } from "@parity/product-sdk-contracts/pvm";
import { createDevSigner, ensureAccountMapped, getDevPublicKey } from "@parity/product-sdk-tx";
import { ss58ToH160 } from "@parity/product-sdk-address";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_BASE = join(__dirname, "..", "..", "contracts", "quizzler", "target", "quizzler.release");
const ADDRESS_FILE = join(__dirname, "..", "src", "contract-address.json");
const ABI_FILE = join(__dirname, "..", "src", "abi.json");

const RPC = process.env.PASEO_AH_RPC ?? "wss://paseo-asset-hub-next-rpc.polkadot.io";
const DEV_ACCOUNT = (process.env.DEPLOY_DEV_ACCOUNT ?? "Alice") as Parameters<typeof createDevSigner>[0];

async function main(): Promise<void> {
    console.log(`Loading artifacts from ${CONTRACT_BASE}.{polkavm,abi.json}`);
    const artifacts = await loadPvmContractArtifacts(CONTRACT_BASE);
    console.log(`  bytecode: ${artifacts.bytecode.length} bytes, abi: ${artifacts.abi.length} entries`);

    console.log(`Connecting to ${RPC}`);
    const client = createClient(getWsProvider(RPC));
    const api = client.getTypedApi(paseo_asset_hub);

    const signer = createDevSigner(DEV_ACCOUNT);
    const address = AccountId(0).dec(getDevPublicKey(DEV_ACCOUNT));
    console.log(`Deploying as //${DEV_ACCOUNT} (${address})`);

    const balance = await api.query.System.Account.getValue(address);
    console.log(`  free balance: ${balance.data.free}`);
    if (balance.data.free === 0n) {
        throw new Error(`//${DEV_ACCOUNT} holds no PAS on this chain — fund it or pick another account`);
    }

    console.log("Ensuring deployer account is mapped on pallet-revive…");
    const checker = {
        addressIsMapped: async (addr: string) =>
            (await api.query.Revive.OriginalAccount.getValue(ss58ToH160(addr))) !== undefined,
    };
    const mapped = await ensureAccountMapped(address, signer, checker, api);
    console.log(mapped === null ? "  already mapped" : `  mapped in block ${mapped.block.number}`);

    // PAPI v2: binary tx fields take raw Uint8Array; Binary is hex/text helpers
    const code = artifacts.bytecode;
    const data = new Uint8Array(0); // constructor takes no args

    console.log("Dry-running instantiate…");
    const dryRun = await api.apis.ReviveApi.instantiate(
        address,
        0n, // value
        undefined, // gas_limit — let the runtime estimate
        undefined, // storage_deposit_limit
        { type: "Upload", value: code },
        data,
        undefined, // salt — None: address derives from deployer+nonce
    );
    if (!dryRun.result.success) {
        throw new Error(`instantiate dry-run failed: ${JSON.stringify(dryRun.result.value, bigintReplacer)}`);
    }
    const predictedAddr = dryRun.result.value.addr; // decoded as hex string
    const gas = dryRun.weight_required;
    console.log(`  predicted address: ${predictedAddr}`);
    console.log(`  gas required: ref_time=${gas.ref_time} proof_size=${gas.proof_size}`);

    // Pad the dry-run estimates — state can drift between dry-run and inclusion.
    const gasLimit = {
        ref_time: (gas.ref_time * 13n) / 10n,
        proof_size: (gas.proof_size * 13n) / 10n,
    };
    const storageDeposit =
        dryRun.storage_deposit.type === "Charge" ? (dryRun.storage_deposit.value * 13n) / 10n : 0n;

    console.log("Submitting Revive.instantiate_with_code…");
    const result = await api.tx.Revive.instantiate_with_code({
        value: 0n,
        weight_limit: gasLimit,
        storage_deposit_limit: storageDeposit,
        code,
        data,
        salt: undefined,
    }).signAndSubmit(signer);

    if (!result.ok) {
        throw new Error(`deploy failed: ${JSON.stringify(result.dispatchError, bigintReplacer)}`);
    }
    console.log(`  included in block #${result.block.number} (${result.txHash})`);

    // Prefer the address from the Instantiated event; fall back to the dry-run.
    const instantiated = result.events.find(
        (e) => e.type === "Revive" && (e.value as { type: string }).type === "Instantiated",
    );
    const rawContract = instantiated
        ? (instantiated.value as { value: { contract: string | Uint8Array } }).value.contract
        : predictedAddr;
    const deployedAddr = typeof rawContract === "string" ? rawContract : Binary.toHex(rawContract);

    await writeFile(
        ADDRESS_FILE,
        `${JSON.stringify({ address: deployedAddr, chain: "paseo-asset-hub", deployedAt: new Date().toISOString() }, null, 4)}\n`,
    );
    await copyFile(`${CONTRACT_BASE}.abi.json`, ABI_FILE);
    console.log(`\nDeployed Quizzler at ${deployedAddr}`);
    console.log(`Wrote ${ADDRESS_FILE} and refreshed abi.json`);

    client.destroy();
}

function bigintReplacer(_k: string, v: unknown): unknown {
    return typeof v === "bigint" ? v.toString() : v;
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
