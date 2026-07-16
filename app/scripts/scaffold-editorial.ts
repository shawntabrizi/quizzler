import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sourceManifestFilename } from "../src/editorial-validation";
import { validatePack } from "../src/pack-validation";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packsDir = join(__dirname, "..", "..", "shared", "packs");
const sourcesDir = join(__dirname, "..", "..", "shared", "pack-sources");

interface ExistingManifest {
  status?: unknown;
  questions?: unknown;
}

function isEmptyDraft(existing: ExistingManifest): boolean {
  return (
    existing.status === "draft" &&
    Array.isArray(existing.questions) &&
    existing.questions.length === 0
  );
}

function idPrefix(file: string): string {
  const base = file.replace(/\.json$/u, "").replace(/^\d+-/u, "");
  return `qz-${base
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase()}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // pnpm forwards the conventional argument separator to tsx on some
  // versions, so accept both `pnpm script -- file.json` and direct tsx use.
  if (args[0] === "--") args.shift();
  const [file, ...unknown] = args;
  if (
    !file ||
    unknown.length > 0 ||
    basename(file) !== file ||
    !file.endsWith(".json")
  ) {
    throw new Error(
      "Usage: pnpm scaffold:editorial -- <starter-pack-file.json>",
    );
  }

  const packPath = join(packsDir, file);
  const pack = validatePack(JSON.parse(await readFile(packPath, "utf8")), file);
  const output = join(sourcesDir, sourceManifestFilename(file));
  let existing: ExistingManifest | null = null;
  try {
    existing = JSON.parse(await readFile(output, "utf8")) as ExistingManifest;
  } catch (error: unknown) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  if (existing && !isEmptyDraft(existing)) {
    throw new Error(
      `${output} already has editorial entries. Preserve existing stable IDs instead of overwriting it.`,
    );
  }

  const prefix = idPrefix(file);
  const manifest = {
    version: 1,
    status: "draft",
    pack: { file, title: pack.title },
    questions: pack.questions.map((question, index) => ({
      id: `${prefix}-q${String(index + 1).padStart(3, "0")}`,
      question: question.text,
      answers: question.answers,
      difficulty: question.difficulty,
    })),
  };
  await mkdir(sourcesDir, { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `Wrote ${output}. It remains draft until every entry has provenance and two approved reviews.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
