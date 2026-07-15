export interface PackListItem {
    id: number;
    title: string;
    /** Immutable creator-selected artwork returned by the registry. */
    emoji: string;
    regular_count: number;
    finals_set_count?: number;
}

export interface PackPresentation {
    emoji: string;
    category: string;
    description: string;
    tone: string;
    featuredOrder?: number;
}

interface StarterPack extends PackPresentation {
    id: number;
    title: string;
}

/**
 * The fresh registry is seeded in this order. IDs and titles must agree, so a
 * later community pack cannot impersonate a featured pack just by choosing
 * the same title. Artwork intentionally does not participate in that check:
 * the creator-selected raw emoji from the registry is the source of truth.
 *
 * The creator-selected emoji in the registry remains the visual source of
 * truth; starter metadata supplies only the category and ordering.
 */
const STARTER_PACKS: readonly StarterPack[] = [
    { id: 0, title: "General Knowledge", emoji: "🧠", category: "Classic", description: "A little bit of everything.", tone: "violet", featuredOrder: 0 },
    { id: 1, title: "Movies & TV", emoji: "🎬", category: "Screen", description: "Big screens, small screens, iconic scenes.", tone: "rose", featuredOrder: 1 },
    { id: 2, title: "Music", emoji: "🎵", category: "Sounds", description: "Songs, artists, and music history.", tone: "pink", featuredOrder: 2 },
    { id: 3, title: "Science & Nature", emoji: "🔬", category: "Discovery", description: "The natural world and how it works.", tone: "green", featuredOrder: 3 },
    { id: 4, title: "Geography", emoji: "🌍", category: "World", description: "Places, people, and maps.", tone: "blue", featuredOrder: 4 },
    { id: 5, title: "History", emoji: "🏛️", category: "Past", description: "Moments that shaped the world.", tone: "amber", featuredOrder: 5 },
    { id: 6, title: "Sports", emoji: "🏆", category: "Play", description: "Teams, tournaments, and sporting legends.", tone: "orange", featuredOrder: 6 },
    { id: 7, title: "Food & Drink", emoji: "🍜", category: "Taste", description: "Flavours, dishes, and culinary lore.", tone: "red", featuredOrder: 7 },
    { id: 8, title: "Video Games", emoji: "🎮", category: "Play", description: "From arcade classics to modern worlds.", tone: "cyan", featuredOrder: 8 },
    { id: 9, title: "Tech & Crypto", emoji: "🤖", category: "Future", description: "The tools and ideas changing tomorrow.", tone: "indigo", featuredOrder: 9 },
];

const FALLBACK_ART: readonly Pick<PackPresentation, "emoji" | "tone">[] = [
    { emoji: "✨", tone: "violet" },
    { emoji: "🎯", tone: "blue" },
    { emoji: "🃏", tone: "rose" },
    { emoji: "🎉", tone: "orange" },
    { emoji: "🌙", tone: "indigo" },
    { emoji: "🪩", tone: "pink" },
];

/** Packs created by the public-chain E2E suite are not player-facing content. */
export function isE2ETestPack(title: string): boolean {
    return /^E2E (?:Builder|Game) \d+$/i.test(title.trim());
}

function hashTitle(title: string): number {
    let hash = 0;
    for (const char of title) {
        hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
    }
    return hash;
}

/** Return curated metadata only for the verified starter record. */
export function featuredPack<T extends PackListItem>(pack: T): StarterPack | undefined {
    const starter = STARTER_PACKS[pack.id];
    if (!starter || starter.title !== pack.title) return undefined;
    return starter;
}

/**
 * Presentation always favors the raw immutable emoji sent by the registry.
 * A deterministic fallback merely protects the UI from malformed content.
 */
export function packPresentation(pack: PackListItem): PackPresentation {
    const featured = featuredPack(pack);
    const emoji = pack.emoji.trim();
    if (featured) return { ...featured, emoji: emoji || featured.emoji };
    const fallback = FALLBACK_ART[hashTitle(pack.title) % FALLBACK_ART.length];
    return {
        emoji: emoji || fallback.emoji,
        category: "Community",
        description: "A community-created quiz pack.",
        tone: fallback.tone,
    };
}

export interface PackSections<T extends PackListItem> {
    featured: T[];
    community: T[];
}

/**
 * A casual home screen leads with the curated starter catalog. Community
 * packs remain discoverable in a secondary section, ordered newest first.
 */
export function sectionPacks<T extends PackListItem>(
    packs: readonly T[],
    search: string,
    includeE2ETestPacks: boolean,
): PackSections<T> {
    const needle = search.trim().toLocaleLowerCase();
    const matching = packs.filter((pack) => {
        if (!includeE2ETestPacks && isE2ETestPack(pack.title)) return false;
        return needle === "" || pack.title.toLocaleLowerCase().includes(needle);
    });
    const featured = matching
        .filter((pack) => featuredPack(pack) !== undefined)
        .sort((a, b) => featuredPack(a)!.featuredOrder! - featuredPack(b)!.featuredOrder!);
    const community = matching
        .filter((pack) => featuredPack(pack) === undefined)
        .sort((a, b) => b.id - a.id);
    return { featured, community };
}

export const STARTER_PACK_COUNT = STARTER_PACKS.length;
