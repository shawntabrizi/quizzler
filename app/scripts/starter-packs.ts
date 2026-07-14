import starterPackMetadata from "../../shared/starter-pack-metadata.json";

export const MAX_EMOJI_BYTES = 32;

export interface StarterPackMetadata {
    file: string;
    title: string;
    emoji: string;
}

interface StarterPackManifest {
    version: number;
    packs: StarterPackMetadata[];
}

const manifest = starterPackMetadata as StarterPackManifest;

if (manifest.version !== 1 || !Array.isArray(manifest.packs)) {
    throw new Error("shared/starter-pack-metadata.json has an unsupported format");
}

export const starterPacks = manifest.packs;

/**
 * The starter-pack manifest is the source of truth for the immutable emoji
 * passed to the registry at creation time. Matching both filename and title
 * catches accidental content/metadata drift before it reaches the chain.
 */
export function starterPackEmoji(file: string, title: string): string {
    const metadata = starterPacks.find((pack) => pack.file === file);
    if (!metadata) {
        throw new Error(`No starter-pack metadata for ${file}`);
    }
    if (metadata.title !== title) {
        throw new Error(
            `${file}: metadata title ${JSON.stringify(metadata.title)} does not match pack title ${JSON.stringify(title)}`,
        );
    }
    return metadata.emoji;
}

/** Validate manifest integrity independently of chain access. */
export function validateStarterPackMetadata(packFiles: readonly string[]): void {
    const files = new Set<string>();
    const titles = new Set<string>();
    for (const metadata of starterPacks) {
        if (!metadata.file.endsWith(".json") || !metadata.file || files.has(metadata.file)) {
            throw new Error(`starter-pack metadata has an invalid or duplicate file: ${JSON.stringify(metadata.file)}`);
        }
        if (!metadata.title.trim() || titles.has(metadata.title)) {
            throw new Error(`starter-pack metadata has an invalid or duplicate title: ${JSON.stringify(metadata.title)}`);
        }
        if (!metadata.emoji.trim() || new TextEncoder().encode(metadata.emoji).byteLength > MAX_EMOJI_BYTES) {
            throw new Error(`${metadata.file}: emoji must be 1–${MAX_EMOJI_BYTES} UTF-8 bytes`);
        }
        files.add(metadata.file);
        titles.add(metadata.title);
    }

    const contentFiles = new Set(packFiles);
    for (const file of files) {
        if (!contentFiles.has(file)) throw new Error(`starter-pack metadata references missing pack file ${file}`);
    }
    for (const file of contentFiles) {
        if (!files.has(file)) throw new Error(`starter pack ${file} is missing immutable emoji metadata`);
    }
}
