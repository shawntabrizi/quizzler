/**
 * Friendly, stable player identities for party UI.
 *
 * A custom alias always wins. When no alias is stored on-chain, the fallback
 * is derived deterministically from the account identity, so every device and
 * every player sees the same friendly label without storing more profile data.
 */

const ADJECTIVES = [
    "Amber", "Brave", "Bright", "Calm", "Clever", "Cosmic", "Daring", "Dazzling",
    "Eager", "Friendly", "Gentle", "Golden", "Happy", "Jolly", "Kind", "Lively",
    "Lucky", "Merry", "Mighty", "Nimble", "Playful", "Proud", "Quick", "Radiant",
    "Silly", "Sparkly", "Sunny", "Swift", "Valiant", "Witty", "Zesty", "Zippy",
] as const;

const ANIMALS = [
    "Badger", "Bear", "Bee", "Cat", "Dolphin", "Falcon", "Fox", "Frog",
    "Giraffe", "Hedgehog", "Koala", "Llama", "Lynx", "Marten", "Monkey", "Narwhal",
    "Octopus", "Otter", "Panda", "Penguin", "Puffin", "Rabbit", "Raccoon", "Seal",
    "Sloth", "Sparrow", "Tiger", "Turtle", "Whale", "Wolf", "Yak", "Zebra",
] as const;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const TIE_BREAK_SALT = 0x9e3779b97f4a7c15n;

function h160Bytes(value: string): Uint8Array | null {
    const hex = value.trim().replace(/^0x/i, "");
    if (!/^[\da-f]{40}$/iu.test(hex)) return null;

    const bytes = new Uint8Array(20);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

function hashBytes(bytes: Uint8Array, salt = 0n): bigint {
    let hash = BigInt.asUintN(64, FNV_OFFSET ^ salt);
    for (const byte of bytes) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * FNV_PRIME);
    }
    return hash;
}

/** Never surface a malformed identity string as UI text, either. */
function stableBytes(value: string): Uint8Array {
    const parsed = h160Bytes(value);
    if (parsed !== null) return parsed;

    let hash = FNV_OFFSET;
    for (let index = 0; index < value.length; index += 1) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(value.charCodeAt(index))) * FNV_PRIME);
    }
    const bytes = new Uint8Array(20);
    for (let index = 0; index < bytes.length; index += 1) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(index)) * FNV_PRIME);
        bytes[index] = Number(hash & 0xffn);
    }
    return bytes;
}

function tagFor(bytes: Uint8Array, salt = 0n): string {
    // 64 bits makes a collision between party-sized rosters fantastically
    // unlikely while remaining a compact, non-address-like player tag.
    return hashBytes(bytes, salt).toString(36).toUpperCase().padStart(13, "0");
}

function savedAlias(value: string | undefined): string {
    return value?.trim() ?? "";
}

/** A deterministic, friendly, collision-resistant identity for an address. */
export function generatedPlayerName(address: string): string {
    const bytes = stableBytes(address);
    return `${ADJECTIVES[bytes[0] % ADJECTIVES.length]} ${ANIMALS[bytes[1] % ANIMALS.length]} · ${tagFor(bytes)}`;
}

/** The player's selected alias when present, otherwise their generated name. */
export function playerName(address: string, alias?: string): string {
    return savedAlias(alias) || generatedPlayerName(address);
}

/**
 * Resolve the whole roster at once so deliberately duplicated aliases remain
 * understandable. A custom alias is kept intact and gets a friendly tag only
 * when another person at this table chose the same visible name.
 */
export function playerLabels(players: readonly string[], aliases: readonly string[]): string[] {
    const baseLabels = players.map((address, index) => playerName(address, aliases[index]));
    const counts = new Map<string, number>();
    for (const label of baseLabels) {
        const key = label.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return baseLabels.map((label, index) => {
        if ((counts.get(label.toLowerCase()) ?? 0) < 2) return label;
        const alias = savedAlias(aliases[index]);
        const bytes = stableBytes(players[index]);
        const discriminator = tagFor(bytes, TIE_BREAK_SALT);
        return alias ? `${alias} · ${discriminator}` : `${label} · ${discriminator}`;
    });
}
