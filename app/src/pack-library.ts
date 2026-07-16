import { isE2ETestPack, type PackListItem } from "./pack-presentation";

export type PackLibrarySectionId = "picks" | "favorites" | "popular" | "new";

export interface PackLibrarySection<T extends PackListItem> {
    id: PackLibrarySectionId;
    title: string;
    packs: T[];
}

export interface PackLibraryInput<T extends PackListItem> {
    picks: readonly T[];
    favorites: readonly T[];
    popular: readonly T[];
    newest: readonly T[];
    search?: string;
    includeE2ETestPacks: boolean;
}

/**
 * The library deliberately retains ordering from each decentralized source:
 * starter order is editorial, favorites are the player's saved order, and
 * popular/newest ordering comes directly from their respective contracts.
 */
export function visibleLibraryPacks<T extends PackListItem>(
    packs: readonly T[],
    search: string,
    includeE2ETestPacks: boolean,
): T[] {
    const needle = search.trim().toLocaleLowerCase();
    const seen = new Set<number>();
    return packs.filter((pack) => {
        if (seen.has(pack.id)) return false;
        seen.add(pack.id);
        if (!includeE2ETestPacks && isE2ETestPack(pack.title)) return false;
        return needle === "" || pack.title.toLocaleLowerCase().includes(needle);
    });
}

/**
 * Empty personal/social rails do not consume vertical space. A populated rail
 * may contain just one pack; that is meaningful early in the catalog's life.
 */
export function buildPackLibrarySections<T extends PackListItem>(
    input: PackLibraryInput<T>,
): PackLibrarySection<T>[] {
    const source: readonly [PackLibrarySectionId, string, readonly T[]][] = [
        ["picks", "Quizzler picks", input.picks],
        ["favorites", "Your favorites", input.favorites],
        ["popular", "Popular", input.popular],
        ["new", "New community packs", input.newest],
    ];
    return source.flatMap(([id, title, packs]) => {
        const visible = visibleLibraryPacks(packs, input.search ?? "", input.includeE2ETestPacks);
        return visible.length > 0 ? [{ id, title, packs: visible }] : [];
    });
}

/** Append a cursor page without duplicating immutable pack ids already shown. */
export function appendUniquePacks<T extends PackListItem>(existing: readonly T[], page: readonly T[]): T[] {
    const seen = new Set(existing.map((pack) => pack.id));
    return [...existing, ...page.filter((pack) => {
        if (seen.has(pack.id)) return false;
        seen.add(pack.id);
        return true;
    })];
}
