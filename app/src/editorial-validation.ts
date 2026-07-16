import {
  normalizeAcceptedAnswers,
  type PackFile,
  type PackQuestion,
} from "./pack-validation";

/**
 * Editorial provenance is deliberately kept out of the deployable pack JSON.
 * A pack is still just title/questions/finals on-chain; this module validates
 * the versioned, repository-only review record that accompanies starter packs.
 */
export const EDITORIAL_MANIFEST_VERSION = 1;

export const EDITORIAL_STATUSES = ["draft", "release-ready"] as const;
export type EditorialStatus = (typeof EDITORIAL_STATUSES)[number];

export const EDITORIAL_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type EditorialDifficulty = (typeof EDITORIAL_DIFFICULTIES)[number];

export const EDITORIAL_STABILITIES = ["stable", "dynamic"] as const;
export type EditorialStability = (typeof EDITORIAL_STABILITIES)[number];

/** Rights classification for a source, distinct from how we used its facts. */
export const SOURCE_RIGHTS_CLASSIFICATIONS = [
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "public-domain",
  "US-government-work",
  "Open-Government-Licence-3.0",
] as const;
export type SourceRightsClassification =
  (typeof SOURCE_RIGHTS_CLASSIFICATIONS)[number];

const REVIEWER_ROLES = ["fact-check", "editorial"] as const;
const REVIEWER_STATUSES = ["approved", "pending", "needs-changes"] as const;
const FINAL_DIFFICULTIES = EDITORIAL_DIFFICULTIES;
const DYNAMIC_PROMPT =
  /\b(?:as\s+of|currently|current|today|latest|newest|most\s+recent|this\s+(?:year|month|week)|right\s+now)\b/iu;
const SUPERLATIVE_PROMPT =
  /\b(?:largest|smallest|longest|shortest|highest|lowest|fastest|slowest|oldest|youngest|first|last|most|least|best|worst|tallest|deepest|widest)\b/iu;
const BASIC_FACT_PROMPT =
  /^(?:what\s+color\s+is|how\s+many\s+(?:days|minutes|hours|sides|legs|wheels)|what\s+is\s+the\s+opposite\s+of)\b/iu;
const QUESTION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u;
const REVIEWER_HANDLE = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
]);
const QUESTION_FORM_TOKENS = new Set([
  "animal",
  "book",
  "city",
  "country",
  "film",
  "game",
  "movie",
  "name",
  "number",
  "ocean",
  "person",
  "place",
  "planet",
  "river",
  "song",
  "state",
  "thing",
  "year",
]);

export interface EditorialSource {
  url: string;
  rights: SourceRightsClassification;
  /** Quizzler verifies facts but always writes its own prompt and answers. */
  use: "fact-verification";
  attribution?: string;
}

export interface EditorialReviewer {
  handle: string;
  role: (typeof REVIEWER_ROLES)[number];
  status: (typeof REVIEWER_STATUSES)[number];
  reviewed_on: string;
}

export interface DynamicReview {
  reviewed_on: string;
  review_due: string;
  reason: string;
}

/**
 * Draft entries only need the stable identity and the pack content they are
 * keyed to. Release-ready entries additionally require every provenance field.
 */
export interface EditorialEntry {
  id: string;
  question: string;
  answers: string[];
  sources?: EditorialSource[];
  verified_on?: string;
  stability?: EditorialStability;
  dynamic_review?: DynamicReview;
  /** Defines a record, measurement, jurisdiction, or other necessary qualifier. */
  scope?: string;
  difficulty?: EditorialDifficulty;
  reviewers?: EditorialReviewer[];
}

export interface PackEditorialManifest {
  version: number;
  status: EditorialStatus;
  pack: {
    file: string;
    title: string;
  };
  questions: EditorialEntry[];
  finals: Partial<Record<EditorialDifficulty, EditorialEntry>>;
}

export interface EditorialPackInput {
  file: string;
  pack: PackFile;
  manifest: unknown;
}

export interface EditorialCoverageReport {
  file: string;
  status: EditorialStatus;
  documented: number;
  total: number;
  warnings: string[];
}

export interface EditorialAuditOptions {
  /** Also require full provenance for draft manifests. Useful once the library is fully curated. */
  all?: boolean;
}

export class EditorialValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join("\n"));
    this.name = "EditorialValidationError";
  }
}

interface IssueCollector {
  issues: string[];
  add: (message: string) => void;
}

interface ParsedManifest {
  status: EditorialStatus | null;
  questions: ParsedEntry[];
  finals: Partial<Record<EditorialDifficulty, ParsedEntry>>;
}

interface ParsedEntry {
  value: Record<string, unknown>;
  where: string;
  id: string | null;
  question: string | null;
  answers: string[] | null;
}

interface ActiveQuestion {
  file: string;
  where: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(
  value: unknown,
  values: T,
): value is T[number] {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function issue(
  collector: IssueCollector,
  where: string,
  message: string,
): void {
  collector.add(`${where}: ${message}`);
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function normalizedAnswers(answers: readonly string[]): string[] {
  return normalizeAcceptedAnswers(answers).sort();
}

function sameAcceptedAnswers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = normalizedAnswers(left);
  const b = normalizedAnswers(right);
  return (
    a.length === b.length && a.every((answer, index) => answer === b[index])
  );
}

/** Kept separate from answer normalization because prompts must retain word boundaries. */
export function normalizeQuestionText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function contentTokens(text: string): string[] {
  return [
    ...new Set(
      normalizeQuestionText(text)
        .split(" ")
        .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
    ),
  ].sort();
}

/**
 * Exact normalized prompts are duplicates. The secondary content-token check
 * intentionally catches reworded versions of the same prompt without trying
 * to guess semantic equivalence from an opaque AI model.
 */
export function likelyDuplicateQuestion(left: string, right: string): boolean {
  const normalizedLeft = normalizeQuestionText(left);
  const normalizedRight = normalizeQuestionText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const a = contentTokens(left).filter(
    (token) => !QUESTION_FORM_TOKENS.has(token),
  );
  const b = contentTokens(right).filter(
    (token) => !QUESTION_FORM_TOKENS.has(token),
  );
  if (a.length < 2 || b.length < 2) return false;
  const aSet = new Set(a);
  const shared = b.filter((token) => aSet.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return shared === union || shared / union >= 0.9;
}

export function sourceManifestFilename(packFile: string): string {
  return `${packFile.replace(/\.json$/u, "")}.sources.json`;
}

function parseEntry(
  value: unknown,
  where: string,
  collector: IssueCollector,
): ParsedEntry {
  if (!isRecord(value)) {
    issue(collector, where, "expected an object");
    return { value: {}, where, id: null, question: null, answers: null };
  }

  const id = nonEmptyString(value.id);
  if (!id || !QUESTION_ID.test(id)) {
    issue(
      collector,
      where,
      "id must be a stable lowercase slug such as qz-geography-q001",
    );
  }

  const question = nonEmptyString(value.question);
  if (!question)
    issue(
      collector,
      where,
      "question must be the exact prompt currently in the pack",
    );

  let answers: string[] | null = null;
  if (
    !Array.isArray(value.answers) ||
    value.answers.length === 0 ||
    !value.answers.every((answer) => nonEmptyString(answer))
  ) {
    issue(
      collector,
      where,
      "answers must contain the accepted answer variants currently in the pack",
    );
  } else {
    answers = value.answers as string[];
  }

  return { value, where, id, question, answers };
}

function parseManifest(
  input: EditorialPackInput,
  collector: IssueCollector,
): ParsedManifest {
  const where = sourceManifestFilename(input.file);
  if (!isRecord(input.manifest)) {
    issue(collector, where, "expected a JSON object");
    return { status: null, questions: [], finals: {} };
  }
  if (input.manifest.version !== EDITORIAL_MANIFEST_VERSION) {
    issue(collector, where, `version must be ${EDITORIAL_MANIFEST_VERSION}`);
  }
  const status = isOneOf(input.manifest.status, EDITORIAL_STATUSES)
    ? input.manifest.status
    : null;
  if (!status)
    issue(
      collector,
      where,
      `status must be one of ${EDITORIAL_STATUSES.join(", ")}`,
    );

  const pack = isRecord(input.manifest.pack) ? input.manifest.pack : null;
  if (!pack) {
    issue(
      collector,
      where,
      "pack must identify the matching starter-pack file and title",
    );
  } else {
    if (pack.file !== input.file)
      issue(
        collector,
        where,
        `pack.file must be ${JSON.stringify(input.file)}`,
      );
    if (pack.title !== input.pack.title)
      issue(
        collector,
        where,
        `pack.title must be ${JSON.stringify(input.pack.title)}`,
      );
  }

  const rawQuestions = input.manifest.questions;
  const questions = Array.isArray(rawQuestions)
    ? rawQuestions.map((entry, index) =>
        parseEntry(entry, `${where} questions[${index}]`, collector),
      )
    : (issue(collector, where, "questions must be an array"), []);

  const rawFinals = input.manifest.finals;
  const finals: Partial<Record<EditorialDifficulty, ParsedEntry>> = {};
  if (!isRecord(rawFinals)) {
    issue(collector, where, "finals must be an object");
  } else {
    for (const key of Object.keys(rawFinals)) {
      if (!isOneOf(key, FINAL_DIFFICULTIES)) {
        issue(
          collector,
          where,
          `finals contains unsupported difficulty ${JSON.stringify(key)}`,
        );
        continue;
      }
      finals[key] = parseEntry(
        rawFinals[key],
        `${where} finals.${key}`,
        collector,
      );
    }
  }

  return { status, questions, finals };
}

function validateSource(
  source: unknown,
  where: string,
  collector: IssueCollector,
): void {
  if (!isRecord(source)) {
    issue(collector, where, "source must be an object");
    return;
  }
  const url = nonEmptyString(source.url);
  try {
    const parsed = url ? new URL(url) : null;
    if (!parsed || parsed.protocol !== "https:" || !parsed.hostname) {
      issue(collector, where, "source.url must be a secure https URL");
    }
  } catch {
    issue(collector, where, "source.url must be a secure https URL");
  }
  if (!isOneOf(source.rights, SOURCE_RIGHTS_CLASSIFICATIONS)) {
    issue(
      collector,
      where,
      `source.rights must be one of ${SOURCE_RIGHTS_CLASSIFICATIONS.join(", ")}`,
    );
  }
  if (source.use !== "fact-verification") {
    issue(
      collector,
      where,
      "source.use must be fact-verification; Quizzler never copies source wording",
    );
  }
  if (
    (source.rights === "CC-BY-4.0" || source.rights === "CC-BY-SA-4.0") &&
    !nonEmptyString(source.attribution)
  ) {
    issue(collector, where, "CC-BY sources require a concise attribution");
  }
}

function validateReviewer(
  reviewer: unknown,
  where: string,
  collector: IssueCollector,
): EditorialReviewer | null {
  if (!isRecord(reviewer)) {
    issue(collector, where, "reviewer must be an object");
    return null;
  }
  const handle = nonEmptyString(reviewer.handle);
  if (!handle || !REVIEWER_HANDLE.test(handle)) {
    issue(
      collector,
      where,
      "reviewer.handle must be a stable lowercase handle",
    );
  }
  if (!isOneOf(reviewer.role, REVIEWER_ROLES)) {
    issue(
      collector,
      where,
      `reviewer.role must be one of ${REVIEWER_ROLES.join(", ")}`,
    );
  }
  if (!isOneOf(reviewer.status, REVIEWER_STATUSES)) {
    issue(
      collector,
      where,
      `reviewer.status must be one of ${REVIEWER_STATUSES.join(", ")}`,
    );
  }
  const reviewedOn = nonEmptyString(reviewer.reviewed_on);
  if (!reviewedOn || !validIsoDate(reviewedOn)) {
    issue(
      collector,
      where,
      "reviewer.reviewed_on must be a real YYYY-MM-DD date",
    );
  }
  if (
    !handle ||
    !isOneOf(reviewer.role, REVIEWER_ROLES) ||
    !isOneOf(reviewer.status, REVIEWER_STATUSES) ||
    !reviewedOn ||
    !validIsoDate(reviewedOn)
  ) {
    return null;
  }
  return {
    handle,
    role: reviewer.role,
    status: reviewer.status,
    reviewed_on: reviewedOn,
  };
}

function validateDynamicReview(
  value: unknown,
  where: string,
  collector: IssueCollector,
): boolean {
  if (!isRecord(value)) {
    issue(
      collector,
      where,
      "dynamic_review must record reviewed_on, review_due, and a reason",
    );
    return false;
  }
  const reviewedOn = nonEmptyString(value.reviewed_on);
  const reviewDue = nonEmptyString(value.review_due);
  const reason = nonEmptyString(value.reason);
  const datesValid = Boolean(
    reviewedOn &&
    reviewDue &&
    validIsoDate(reviewedOn) &&
    validIsoDate(reviewDue),
  );
  if (!datesValid)
    issue(
      collector,
      where,
      "dynamic_review dates must be real YYYY-MM-DD values",
    );
  if (datesValid && reviewDue! <= reviewedOn!)
    issue(
      collector,
      where,
      "dynamic_review.review_due must be after reviewed_on",
    );
  if (!reason)
    issue(
      collector,
      where,
      "dynamic_review.reason must explain what can change",
    );
  return Boolean(datesValid && reviewDue! > reviewedOn! && reason);
}

function validateReleaseMetadata(
  entry: ParsedEntry,
  expectedDifficulty: EditorialDifficulty | null,
  collector: IssueCollector,
): void {
  const value = entry.value;
  const sources = value.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    issue(
      collector,
      entry.where,
      "release-ready content needs at least one provenance source",
    );
  } else {
    sources.forEach((source, index) =>
      validateSource(source, `${entry.where} sources[${index}]`, collector),
    );
  }

  const verifiedOn = nonEmptyString(value.verified_on);
  if (!verifiedOn || !validIsoDate(verifiedOn)) {
    issue(collector, entry.where, "verified_on must be a real YYYY-MM-DD date");
  }

  const stability = isOneOf(value.stability, EDITORIAL_STABILITIES)
    ? value.stability
    : null;
  if (!stability)
    issue(
      collector,
      entry.where,
      `stability must be one of ${EDITORIAL_STABILITIES.join(", ")}`,
    );

  const difficulty = isOneOf(value.difficulty, EDITORIAL_DIFFICULTIES)
    ? value.difficulty
    : null;
  if (!difficulty)
    issue(
      collector,
      entry.where,
      `difficulty must be one of ${EDITORIAL_DIFFICULTIES.join(", ")}`,
    );
  if (expectedDifficulty && difficulty && difficulty !== expectedDifficulty) {
    issue(
      collector,
      entry.where,
      `final difficulty must be ${expectedDifficulty}`,
    );
  }

  const hasDynamicWording = Boolean(
    entry.question && DYNAMIC_PROMPT.test(entry.question),
  );
  const hasDynamicReview =
    value.dynamic_review === undefined
      ? false
      : validateDynamicReview(
          value.dynamic_review,
          `${entry.where} dynamic_review`,
          collector,
        );
  if (stability === "dynamic" && !hasDynamicReview) {
    issue(
      collector,
      entry.where,
      "dynamic content requires dynamic_review metadata",
    );
  }
  if (stability === "stable" && value.dynamic_review !== undefined) {
    issue(
      collector,
      entry.where,
      "stable content must not include dynamic_review metadata",
    );
  }
  if (hasDynamicWording && !(stability === "dynamic" && hasDynamicReview)) {
    issue(
      collector,
      entry.where,
      "current/latest-style wording requires stability: dynamic and dynamic_review metadata",
    );
  }
  if (
    entry.question &&
    SUPERLATIVE_PROMPT.test(entry.question) &&
    !nonEmptyString(value.scope)
  ) {
    issue(
      collector,
      entry.where,
      "superlative wording requires scope metadata (for example, measurement or definition)",
    );
  }

  const rawReviewers = value.reviewers;
  if (!Array.isArray(rawReviewers) || rawReviewers.length === 0) {
    issue(
      collector,
      entry.where,
      "release-ready content needs fact-check and editorial reviewer statuses",
    );
  } else {
    const reviewers = rawReviewers
      .map((reviewer, index) =>
        validateReviewer(
          reviewer,
          `${entry.where} reviewers[${index}]`,
          collector,
        ),
      )
      .filter((reviewer): reviewer is EditorialReviewer => reviewer !== null);
    const approvedByRole = new Map<
      EditorialReviewer["role"],
      EditorialReviewer
    >();
    for (const reviewer of reviewers) {
      if (
        reviewer.status === "approved" &&
        !approvedByRole.has(reviewer.role)
      ) {
        approvedByRole.set(reviewer.role, reviewer);
      }
    }
    const factCheck = approvedByRole.get("fact-check");
    const editorial = approvedByRole.get("editorial");
    if (!factCheck || !editorial) {
      issue(
        collector,
        entry.where,
        "requires approved fact-check and editorial reviews",
      );
    } else if (factCheck.handle === editorial.handle) {
      issue(
        collector,
        entry.where,
        "fact-check and editorial approvals must be from different reviewers",
      );
    }
  }
}

function expectedRegularQuestion(
  entry: ParsedEntry,
  question: PackQuestion,
): boolean {
  return (
    entry.question === question.text &&
    entry.answers !== null &&
    sameAcceptedAnswers(entry.answers, question.answers)
  );
}

function expectedFinalQuestion(
  entry: ParsedEntry | undefined,
  question: PackQuestion,
): boolean {
  return Boolean(entry && expectedRegularQuestion(entry, question));
}

function documentedCoverage(pack: PackFile, parsed: ParsedManifest): number {
  const regular = pack.questions.reduce(
    (count, question) =>
      count +
      (parsed.questions.some((entry) =>
        expectedRegularQuestion(entry, question),
      )
        ? 1
        : 0),
    0,
  );
  const finals = FINAL_DIFFICULTIES.reduce(
    (count, difficulty) =>
      count +
      (expectedFinalQuestion(parsed.finals[difficulty], pack.finals[difficulty])
        ? 1
        : 0),
    0,
  );
  return regular + finals;
}

function validateReleaseCoverage(
  input: EditorialPackInput,
  parsed: ParsedManifest,
  collector: IssueCollector,
): void {
  const where = sourceManifestFilename(input.file);
  if (parsed.questions.length !== input.pack.questions.length) {
    issue(
      collector,
      where,
      `release-ready manifest needs exactly ${input.pack.questions.length} regular entries`,
    );
  }
  for (const [index, question] of input.pack.questions.entries()) {
    const matching = parsed.questions.filter((entry) =>
      expectedRegularQuestion(entry, question),
    );
    if (matching.length === 0) {
      issue(
        collector,
        where,
        `missing provenance for pack question ${index + 1}: ${JSON.stringify(question.text)}`,
      );
    } else if (matching.length > 1) {
      issue(
        collector,
        where,
        `multiple provenance entries match pack question ${index + 1}: ${JSON.stringify(question.text)}`,
      );
    }
  }
  for (const entry of parsed.questions)
    validateReleaseMetadata(entry, null, collector);

  for (const difficulty of FINAL_DIFFICULTIES) {
    const entry = parsed.finals[difficulty];
    if (!expectedFinalQuestion(entry, input.pack.finals[difficulty])) {
      issue(
        collector,
        where,
        `missing or stale provenance for ${difficulty} final`,
      );
    }
    if (entry) validateReleaseMetadata(entry, difficulty, collector);
  }
}

function collectDuplicateIds(
  entries: readonly ParsedEntry[],
  collector: IssueCollector,
): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.id) continue;
    const previous = seen.get(entry.id);
    if (previous) {
      issue(
        collector,
        entry.where,
        `duplicate stable ID ${JSON.stringify(entry.id)} (already used by ${previous})`,
      );
    } else {
      seen.set(entry.id, entry.where);
    }
  }
}

function collectLikelyDuplicates(
  questions: readonly ActiveQuestion[],
  collector: IssueCollector,
): void {
  for (let first = 0; first < questions.length; first += 1) {
    for (let second = first + 1; second < questions.length; second += 1) {
      const a = questions[first]!;
      const b = questions[second]!;
      if (likelyDuplicateQuestion(a.text, b.text)) {
        issue(
          collector,
          `${a.file} ${a.where}`,
          `likely duplicate prompt with ${b.file} ${b.where}: ${JSON.stringify(b.text)}`,
        );
      }
    }
  }
}

function activeQuestions(input: EditorialPackInput): ActiveQuestion[] {
  return [
    ...input.pack.questions.map((question, index) => ({
      file: input.file,
      where: `question ${index + 1}`,
      text: question.text,
    })),
    ...FINAL_DIFFICULTIES.map((difficulty) => ({
      file: input.file,
      where: `${difficulty} final`,
      text: input.pack.finals[difficulty].text,
    })),
  ];
}

function hasCompleteDynamicReview(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const reviewedOn = nonEmptyString(value.reviewed_on);
  const reviewDue = nonEmptyString(value.review_due);
  return Boolean(
    reviewedOn &&
    reviewDue &&
    nonEmptyString(value.reason) &&
    validIsoDate(reviewedOn) &&
    validIsoDate(reviewDue) &&
    reviewDue > reviewedOn,
  );
}

function pushWarning(warnings: string[], message: string): void {
  if (warnings.includes(message)) return;
  // Surface a representative, useful list rather than flooding a PR with a
  // long inherited pack's entire backlog.
  if (warnings.length < 20) warnings.push(message);
}

function matchingEntry(
  parsed: ParsedManifest,
  question: PackQuestion,
  finalDifficulty?: EditorialDifficulty,
): ParsedEntry | undefined {
  if (finalDifficulty) return parsed.finals[finalDifficulty];
  return parsed.questions.find((entry) =>
    expectedRegularQuestion(entry, question),
  );
}

interface ParsedInput {
  input: EditorialPackInput;
  parsed: ParsedManifest;
  report: EditorialCoverageReport;
}

/**
 * Draft lint deliberately reports potentially weak prompts instead of failing
 * the build. It makes inherited content visible during incremental curation;
 * `audit:editorial` turns the resolved issues into hard rules at release.
 */
function collectEditorialAdvisories(inputs: readonly ParsedInput[]): void {
  const allQuestions: Array<
    ActiveQuestion & { report: EditorialCoverageReport }
  > = [];
  for (const { input, parsed, report } of inputs) {
    const checkQuestion = (
      question: PackQuestion,
      where: string,
      finalDifficulty?: EditorialDifficulty,
    ) => {
      const entry = matchingEntry(parsed, question, finalDifficulty);
      const prompt = question.text;
      const stability = entry?.value.stability;
      const dynamicResolved =
        stability === "dynamic" &&
        hasCompleteDynamicReview(entry?.value.dynamic_review);
      if (DYNAMIC_PROMPT.test(prompt) && !dynamicResolved) {
        pushWarning(
          report.warnings,
          `${where}: time-sensitive wording needs dynamic stability and review metadata before release`,
        );
      }
      if (
        SUPERLATIVE_PROMPT.test(prompt) &&
        !nonEmptyString(entry?.value.scope)
      ) {
        pushWarning(
          report.warnings,
          `${where}: superlative wording needs a clear scope/definition before release`,
        );
      }
      const normalized = normalizeQuestionText(prompt);
      if (
        BASIC_FACT_PROMPT.test(prompt) ||
        normalized.split(" ").filter(Boolean).length <= 4 ||
        contentTokens(prompt).length <= 2
      ) {
        pushWarning(
          report.warnings,
          `${where}: likely bare/basic trivia prompt; confirm it is worth a place in a curated pack`,
        );
      }
    };

    input.pack.questions.forEach((question, index) => {
      const where = `question ${index + 1}`;
      checkQuestion(question, where);
      allQuestions.push({
        file: input.file,
        where,
        text: question.text,
        report,
      });
    });
    for (const difficulty of FINAL_DIFFICULTIES) {
      const where = `${difficulty} final`;
      checkQuestion(input.pack.finals[difficulty], where, difficulty);
      allQuestions.push({
        file: input.file,
        where,
        text: input.pack.finals[difficulty].text,
        report,
      });
    }
  }

  // A full semantic duplicate detector would create too many false positives
  // in a party pack. This lint uses the same deterministic likely-duplicate
  // heuristic as the strict audit, but only emits capped advice for drafts.
  for (let first = 0; first < allQuestions.length; first += 1) {
    for (let second = first + 1; second < allQuestions.length; second += 1) {
      const a = allQuestions[first]!;
      const b = allQuestions[second]!;
      if (!likelyDuplicateQuestion(a.text, b.text)) continue;
      pushWarning(
        a.report.warnings,
        `${a.where}: likely duplicate of ${b.file} ${b.where}`,
      );
      pushWarning(
        b.report.warnings,
        `${b.where}: likely duplicate of ${a.file} ${a.where}`,
      );
    }
  }
}

/**
 * Baseline lint always validates manifest identity and every supplied stable
 * ID. Draft manifests are intentionally allowed to be incomplete while a
 * pack is being rewritten. It returns coverage reports rather than turning
 * incremental curation into a broken build.
 */
export function lintEditorialLibrary(
  inputs: readonly EditorialPackInput[],
): EditorialCoverageReport[] {
  return validateEditorialLibrary(inputs, { mode: "lint" });
}

/**
 * Strict audit enforces full provenance only for manifests explicitly marked
 * release-ready. Pass `{ all: true }` to require the whole default library.
 */
export function auditEditorialLibrary(
  inputs: readonly EditorialPackInput[],
  options: EditorialAuditOptions = {},
): EditorialCoverageReport[] {
  return validateEditorialLibrary(inputs, {
    mode: "audit",
    all: options.all === true,
  });
}

function validateEditorialLibrary(
  inputs: readonly EditorialPackInput[],
  options: { mode: "lint" | "audit"; all?: boolean },
): EditorialCoverageReport[] {
  const issues: string[] = [];
  const collector: IssueCollector = {
    issues,
    add: (message) => issues.push(message),
  };
  const reports: EditorialCoverageReport[] = [];
  const suppliedEntries: ParsedEntry[] = [];
  const strictPacks: EditorialPackInput[] = [];
  const parsedInputs: ParsedInput[] = [];

  for (const input of inputs) {
    const parsed = parseManifest(input, collector);
    suppliedEntries.push(...parsed.questions, ...Object.values(parsed.finals));
    const documented = documentedCoverage(input.pack, parsed);
    const total = input.pack.questions.length + FINAL_DIFFICULTIES.length;
    const warnings: string[] = [];
    if (parsed.status === "draft" && documented !== total) {
      warnings.push(
        `draft coverage is ${documented}/${total}; this is allowed until the pack is marked release-ready`,
      );
    }
    const report: EditorialCoverageReport = {
      file: input.file,
      status: parsed.status ?? "draft",
      documented,
      total,
      warnings,
    };
    reports.push(report);
    parsedInputs.push({ input, parsed, report });

    const strict =
      options.mode === "audit" &&
      (options.all || parsed.status === "release-ready");
    if (strict) {
      validateReleaseCoverage(input, parsed, collector);
      strictPacks.push(input);
    }
  }

  collectDuplicateIds(suppliedEntries, collector);
  if (options.mode === "lint") collectEditorialAdvisories(parsedInputs);
  if (options.mode === "audit") {
    collectLikelyDuplicates(strictPacks.flatMap(activeQuestions), collector);
  }

  if (issues.length > 0) throw new EditorialValidationError(issues);
  return reports;
}
