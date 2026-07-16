/**
 * Friendly, stable player identities for party UI.
 *
 * A chosen name always wins. When no name is stored on-chain, the fallback
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

function h160Bytes(value: string): Uint8Array | null {
    const hex = value.trim().replace(/^0x/i, "");
    if (!/^[\da-f]{40}$/iu.test(hex)) return null;

    const bytes = new Uint8Array(20);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
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

function savedName(value: string | undefined): string {
    return value?.trim() ?? "";
}

/** A deterministic, friendly fallback identity for an address. */
export function generatedPlayerName(address: string): string {
    const bytes = stableBytes(address);
    return `${ADJECTIVES[bytes[0] % ADJECTIVES.length]} ${ANIMALS[bytes[1] % ANIMALS.length]}`;
}

/** The player's chosen name when present, otherwise their generated name. */
export function playerName(address: string, name?: string): string {
    return savedName(name) || generatedPlayerName(address);
}

/**
 * Resolve the whole roster at once. Names intentionally stay exactly as people
 * chose them: a casual party of at most 24 people does not need identifier
 * suffixes or blockchain-like codes to distinguish an occasional duplicate.
 */
export function playerLabels(players: readonly string[], names: readonly string[]): string[] {
    return players.map((address, index) => playerName(address, names[index]));
}
