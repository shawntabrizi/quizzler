import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validatePack } from "../src/pack-validation";
import { starterPackEmoji, validateStarterPackMetadata } from "./starter-packs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packsDir = join(__dirname, "..", "..", "shared", "packs");

async function main(): Promise<void> {
    const files = (await readdir(packsDir)).filter((file) => file.endsWith(".json")).sort();
    for (const file of files) {
        const pack = validatePack(JSON.parse(await readFile(join(packsDir, file), "utf8")), file);
        starterPackEmoji(file, pack.title);
    }
    validateStarterPackMetadata(files);
    console.log(`Validated ${files.length} pack file(s).`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
