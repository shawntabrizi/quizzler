import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = join(__dirname, "..", "..", "shared");
const PACKS_DIR = join(SHARED_DIR, "packs");
const METADATA_FILE = join(SHARED_DIR, "starter-pack-metadata.json");

export interface StarterCatalogFingerprint {
    files: string[];
    sha256: string;
}

/**
 * Bind a staged deployment to the exact source catalog that was seeded. File
 * names alone are insufficient: titles, questions, answers, and emoji are all
 * immutable once they have reached the registry.
 */
export async function starterCatalogFingerprint(): Promise<StarterCatalogFingerprint> {
    const files = (await readdir(PACKS_DIR)).filter((file) => file.endsWith(".json")).sort();
    const hash = createHash("sha256");
    hash.update("quizzler-starter-catalog-v1\0");

    for (const file of files) {
        hash.update(file);
        hash.update("\0");
        hash.update(await readFile(join(PACKS_DIR, file)));
        hash.update("\0");
    }

    hash.update("starter-pack-metadata.json\0");
    hash.update(await readFile(METADATA_FILE));
    return { files, sha256: hash.digest("hex") };
}
