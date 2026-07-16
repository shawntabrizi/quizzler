import { describe, expect, it } from "vitest";

import {
  auditEditorialLibrary,
  lintEditorialLibrary,
  likelyDuplicateQuestion,
  normalizeQuestionText,
} from "./editorial-validation";
import type { PackFile } from "./pack-validation";

const source = {
  url: "https://www.wikidata.org/wiki/Q90",
  rights: "CC0-1.0",
  use: "fact-verification",
} as const;
const reviewers = [
  {
    handle: "mira",
    role: "fact-check",
    status: "approved",
    reviewed_on: "2026-07-16",
  },
  {
    handle: "sam",
    role: "editorial",
    status: "approved",
    reviewed_on: "2026-07-16",
  },
] as const;

const pack: PackFile = {
  title: "Curated geography",
  questions: [
    { text: "Which city is the capital of France?", answers: ["Paris"], difficulty: "easy" },
    { text: "What river flows through Paris?", answers: ["Seine"], difficulty: "medium" },
    {
      text: "Which arrondissement contains the Eiffel Tower?",
      answers: ["7th arrondissement", "7th"],
      difficulty: "hard",
    },
  ],
};

function reviewedEntry(
  id: string,
  question: string,
  answers: string[],
  difficulty: "easy" | "medium" | "hard",
) {
  return {
    id,
    question,
    answers,
    sources: [source],
    verified_on: "2026-07-16",
    stability: "stable",
    difficulty,
    reviewers,
  };
}

function reviewedManifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    status: "release-ready",
    pack: { file: "01-curated.json", title: pack.title },
    questions: pack.questions.map((question, index) =>
      reviewedEntry(
        `qz-curated-q${String(index + 1).padStart(3, "0")}`,
        question.text,
        question.answers,
        question.difficulty,
      ),
    ),
    ...overrides,
  };
}

describe("editorial provenance validation", () => {
  it("allows an entirely draft library while still reporting its coverage", () => {
    const reports = lintEditorialLibrary([
      {
        file: "01-curated.json",
        pack,
        manifest: {
          version: 1,
          status: "draft",
          pack: { file: "01-curated.json", title: pack.title },
          questions: [],
        },
      },
    ]);

    expect(reports[0]).toMatchObject({
      status: "draft",
      documented: 0,
      total: 3,
    });
    expect(reports[0]!.warnings.join(" ")).toContain("draft coverage");
  });

  it("requires complete, independently reviewed provenance for a release-ready pack", () => {
    const reports = auditEditorialLibrary([
      {
        file: "01-curated.json",
        pack,
        manifest: reviewedManifest(),
      },
    ]);

    expect(reports[0]).toMatchObject({
      status: "release-ready",
      documented: 3,
      total: 3,
    });
  });

  it("rejects duplicate stable IDs even while a pack is still draft", () => {
    expect(() =>
      lintEditorialLibrary([
        {
          file: "01-curated.json",
          pack,
          manifest: {
            version: 1,
            status: "draft",
            pack: { file: "01-curated.json", title: pack.title },
            questions: [
              {
                id: "qz-curated-q001",
                question: pack.questions[0]!.text,
                answers: pack.questions[0]!.answers,
              },
              {
                id: "qz-curated-q001",
                question: "Another question?",
                answers: ["Answer"],
              },
            ],
          },
        },
      ]),
    ).toThrow("duplicate stable ID");
  });

  it("rejects current-style prompts without dynamic review metadata", () => {
    const dynamicPack: PackFile = {
      ...pack,
      questions: [
        {
          text: "Which country currently has the largest population?",
          answers: ["India"],
          difficulty: "easy",
        },
      ],
    };
    const manifest = reviewedManifest({
      questions: [
        {
          ...reviewedEntry(
            "qz-curated-q001",
            dynamicPack.questions[0]!.text,
            dynamicPack.questions[0]!.answers,
            "easy",
          ),
          stability: "dynamic",
        },
      ],
    });

    expect(() =>
      auditEditorialLibrary([
        { file: "01-curated.json", pack: dynamicPack, manifest },
      ]),
    ).toThrow("dynamic_review");
  });

  it("rejects likely duplicate normalized prompts in a strict audit", () => {
    const duplicatePack: PackFile = {
      ...pack,
      questions: [
        { text: "What is the capital of France?", answers: ["Paris"], difficulty: "easy" },
        { text: "Which city is the capital of France?", answers: ["Paris"], difficulty: "easy" },
      ],
    };
    const manifest = reviewedManifest({
      questions: duplicatePack.questions.map((question, index) =>
        reviewedEntry(
          `qz-curated-q00${index + 1}`,
          question.text,
          question.answers,
          "easy",
        ),
      ),
    });

    expect(() =>
      auditEditorialLibrary([
        { file: "01-curated.json", pack: duplicatePack, manifest },
      ]),
    ).toThrow("likely duplicate prompt");
  });

  it("normalizes and compares prompts deterministically", () => {
    expect(normalizeQuestionText("Café — what IS it?")).toBe("cafe what is it");
    expect(
      likelyDuplicateQuestion(
        "What is the capital of France?",
        "Which city is the capital of France?",
      ),
    ).toBe(true);
    expect(
      likelyDuplicateQuestion(
        "Which river flows through Paris?",
        "Which ocean borders Australia?",
      ),
    ).toBe(false);
  });
});
