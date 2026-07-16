import { utf8ByteLength } from "./input";
import { normalizeAnswer } from "./normalize";

export const MAX_PACK_TITLE_BYTES = 64;
export const MAX_QUESTION_BYTES = 256;
export const MAX_ACCEPTED_ANSWERS = 5;
export const MAX_ANSWER_BYTES = 64;
/** A pack needs one regular round and one unused question for its final. */
export const MIN_PACK_QUESTIONS = 2;
export const MAX_PACK_QUESTIONS = 200;

export const PACK_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type PackDifficulty = (typeof PACK_DIFFICULTIES)[number];

export interface PackQuestion {
    text: string;
    answers: string[];
    /** Editorial tier used for both regular-round pacing and final selection. */
    difficulty: PackDifficulty;
}

export interface PackFile {
    title: string;
    questions: PackQuestion[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The registry stores normalized answers, so only distinct values consume its five-answer cap. */
export function normalizeAcceptedAnswers(answers: readonly string[]): string[] {
    const unique = new Set<string>();
    for (const answer of answers) {
        const normalized = normalizeAnswer(answer);
        if (normalized) unique.add(normalized);
    }
    return [...unique];
}

function validateQuestion(value: unknown, where: string): PackQuestion {
    if (
        !isRecord(value)
        || typeof value.text !== "string"
        || !Array.isArray(value.answers)
        || !PACK_DIFFICULTIES.includes(value.difficulty as PackDifficulty)
    ) {
        throw new Error(`${where}: expected question text, an answers array, and an easy/medium/hard difficulty`);
    }
    if (!value.answers.every((answer) => typeof answer === "string")) {
        throw new Error(`${where}: every accepted answer must be a string`);
    }
    const answers = value.answers as string[];
    if (!value.text.trim() || utf8ByteLength(value.text) > MAX_QUESTION_BYTES || /[\u0000-\u001f\u007f-\u009f]/u.test(value.text)) {
        throw new Error(`${where}: question text must be 1–${MAX_QUESTION_BYTES} UTF-8 bytes`);
    }
    if (answers.length === 0) {
        throw new Error(`${where}: at least one accepted answer is required`);
    }
    for (const answer of answers) {
        if (utf8ByteLength(answer) > MAX_ANSWER_BYTES) {
            throw new Error(`${where}: invalid accepted answer ${JSON.stringify(answer)}`);
        }
        const normalized = normalizeAnswer(answer);
        if (!normalized || normalized.length > MAX_ANSWER_BYTES) {
            throw new Error(`${where}: invalid accepted answer ${JSON.stringify(answer)}`);
        }
    }
    const normalizedAnswers = normalizeAcceptedAnswers(answers);
    if (normalizedAnswers.length > MAX_ACCEPTED_ANSWERS) {
        throw new Error(`${where}: at most ${MAX_ACCEPTED_ANSWERS} distinct accepted answers are allowed`);
    }
    return { text: value.text, answers, difficulty: value.difficulty as PackDifficulty };
}

/** Validate a pack without needing a chain connection. */
export function validatePack(value: unknown, where = "pack"): PackFile {
    if (!isRecord(value) || typeof value.title !== "string" || !Array.isArray(value.questions)) {
        throw new Error(`${where}: expected a title and questions array`);
    }
    if (!value.title.trim() || utf8ByteLength(value.title) > MAX_PACK_TITLE_BYTES || /[\u0000-\u001f\u007f-\u009f]/u.test(value.title)) {
        throw new Error(`${where}: title must be 1–${MAX_PACK_TITLE_BYTES} UTF-8 bytes`);
    }
    if (value.questions.length < MIN_PACK_QUESTIONS || value.questions.length > MAX_PACK_QUESTIONS) {
        throw new Error(`${where}: expected ${MIN_PACK_QUESTIONS}–${MAX_PACK_QUESTIONS} questions`);
    }
    const questions = value.questions.map((question, index) => validateQuestion(question, `${where} question ${index + 1}`));
    return { title: value.title, questions };
}
