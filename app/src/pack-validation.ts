import { utf8ByteLength } from "./input";
import { normalizeAnswer } from "./normalize";

export const MAX_PACK_TITLE_BYTES = 64;
export const MAX_QUESTION_BYTES = 256;
export const MAX_ACCEPTED_ANSWERS = 5;
export const MAX_ANSWER_BYTES = 64;
export const MAX_REGULAR_QUESTIONS = 200;

export interface PackQuestion {
    text: string;
    answers: string[];
}

export interface PackFile {
    title: string;
    questions: PackQuestion[];
    finals: Record<"easy" | "medium" | "hard", PackQuestion>;
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
    if (!isRecord(value) || typeof value.text !== "string" || !Array.isArray(value.answers)) {
        throw new Error(`${where}: expected question text and an answers array`);
    }
    if (!value.answers.every((answer) => typeof answer === "string")) {
        throw new Error(`${where}: every accepted answer must be a string`);
    }
    const answers = value.answers as string[];
    if (!value.text.trim() || utf8ByteLength(value.text) > MAX_QUESTION_BYTES) {
        throw new Error(`${where}: question text must be 1–${MAX_QUESTION_BYTES} UTF-8 bytes`);
    }
    if (answers.length === 0) {
        throw new Error(`${where}: at least one accepted answer is required`);
    }
    for (const answer of answers) {
        const normalized = normalizeAnswer(answer);
        if (!normalized || normalized.length > MAX_ANSWER_BYTES) {
            throw new Error(`${where}: invalid accepted answer ${JSON.stringify(answer)}`);
        }
    }
    if (normalizeAcceptedAnswers(answers).length > MAX_ACCEPTED_ANSWERS) {
        throw new Error(`${where}: at most ${MAX_ACCEPTED_ANSWERS} distinct accepted answers are allowed`);
    }
    return { text: value.text, answers };
}

/** Validate a pack without needing a chain connection. */
export function validatePack(value: unknown, where = "pack"): PackFile {
    if (!isRecord(value) || typeof value.title !== "string" || !Array.isArray(value.questions) || !isRecord(value.finals)) {
        throw new Error(`${where}: expected title, questions, and easy/medium/hard finals`);
    }
    if (!value.title.trim() || utf8ByteLength(value.title) > MAX_PACK_TITLE_BYTES) {
        throw new Error(`${where}: title must be 1–${MAX_PACK_TITLE_BYTES} UTF-8 bytes`);
    }
    if (value.questions.length === 0 || value.questions.length > MAX_REGULAR_QUESTIONS) {
        throw new Error(`${where}: expected 1–${MAX_REGULAR_QUESTIONS} regular questions`);
    }
    const questions = value.questions.map((question, index) => validateQuestion(question, `${where} question ${index + 1}`));
    const finals = {
        easy: validateQuestion(value.finals.easy, `${where} easy final`),
        medium: validateQuestion(value.finals.medium, `${where} medium final`),
        hard: validateQuestion(value.finals.hard, `${where} hard final`),
    };
    return { title: value.title, questions, finals };
}
