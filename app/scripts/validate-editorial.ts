import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditEditorialLibrary,
  lintEditorialLibrary,
  sourceManifestFilename,
} from "../src/editorial-validation";
import { validatePack } from "../src/pack-validation";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packsDir = join(__dirname, "..", "..", "shared", "packs");
const sourcesDir = join(__dirname, "..", "..", "shared", "pack-sources");

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const strict = args.delete("--strict");
  const all = args.delete("--all");
  if (args.size > 0) {
    throw new Error(
      `Unknown option(s): ${[...args].join(", ")}. Use --strict and optional --all.`,
    );
  }
  if (all && !strict) throw new Error("--all requires --strict");

  const files = (await readdir(packsDir))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const inputs = await Promise.all(
    files.map(async (file) => ({
      file,
      pack: validatePack(
        JSON.parse(await readFile(join(packsDir, file), "utf8")),
        file,
      ),
      manifest: JSON.parse(
        await readFile(join(sourcesDir, sourceManifestFilename(file)), "utf8"),
      ),
    })),
  );
  const reports = strict
    ? auditEditorialLibrary(inputs, { all })
    : lintEditorialLibrary(inputs);

  const releaseReady = reports.filter(
    (report) => report.status === "release-ready",
  ).length;
  console.log(
    `${strict ? "Strict editorial audit" : "Editorial draft lint"} passed for ${reports.length} pack(s).`,
  );
  for (const report of reports) {
    const coverageLabel =
      report.status === "release-ready"
        ? "provenance coverage"
        : "editorial record coverage";
    console.log(
      `- ${report.file}: ${report.status}; ${coverageLabel} ${report.documented}/${report.total}`,
    );
    // A duplicate or unresolved dynamic claim is more useful during a
    // first pass than a long list of basic-trivia reminders.
    const warningPriority = (warning: string): number => {
      if (warning.includes("likely duplicate")) return 0;
      if (warning.includes("time-sensitive")) return 1;
      if (warning.includes("superlative")) return 2;
      return 3;
    };
    const visibleWarnings = [...report.warnings]
      .sort((left, right) => warningPriority(left) - warningPriority(right))
      .slice(0, 6);
    for (const warning of visibleWarnings) console.log(`  warning: ${warning}`);
    if (report.warnings.length > visibleWarnings.length) {
      console.log(
        `  warning: ${report.warnings.length - visibleWarnings.length} additional advisory item(s) omitted`,
      );
    }
  }
  if (strict && !all && releaseReady === 0) {
    console.log(
      "No pack is release-ready yet, so the strict audit left draft manifests non-blocking.",
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
