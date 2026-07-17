import { describe, expect, it } from "vitest";
import { answerSubmissionScreenState } from "./answer-submission";

describe("answer submission screen state", () => {
    it("never reveals live answers from a local signing attempt", () => {
        expect(answerSubmissionScreenState(false, true)).toEqual({
            showAnswerForm: true,
            lockAnswerForm: true,
            showLiveAnswers: false,
        });
    });

    it("reveals live answers only after the authoritative snapshot records submission", () => {
        expect(answerSubmissionScreenState(true, true)).toEqual({
            showAnswerForm: false,
            lockAnswerForm: false,
            showLiveAnswers: true,
        });
    });

    it("leaves the form editable after a rejected or failed submission", () => {
        expect(answerSubmissionScreenState(false, false)).toEqual({
            showAnswerForm: true,
            lockAnswerForm: false,
            showLiveAnswers: false,
        });
    });
});
