import { describe, expect, it } from "vite-plus/test";

import { formatPendingPrimaryActionLabel, formatSendActionLabel } from "./ComposerPrimaryActions";

const idleSendLabelInput = {
  isRunning: false,
  isEnvironmentUnavailable: false,
  sendDisabledReason: null,
  isConnecting: false,
  isPreparingWorktree: false,
  isSendBusy: false,
};

describe("formatSendActionLabel", () => {
  it("returns 'Send message' when the thread is idle", () => {
    expect(formatSendActionLabel(idleSendLabelInput)).toBe("Send message");
  });

  it("returns 'Queue message' while a turn is running", () => {
    expect(formatSendActionLabel({ ...idleSendLabelInput, isRunning: true })).toBe("Queue message");
  });

  it("prefers the disconnected environment over every other state", () => {
    expect(
      formatSendActionLabel({
        ...idleSendLabelInput,
        isRunning: true,
        isEnvironmentUnavailable: true,
        sendDisabledReason: "Messages loading",
        isConnecting: true,
        isSendBusy: true,
      }),
    ).toBe("Environment disconnected");
  });

  it("surfaces the send disabled reason ahead of connecting", () => {
    expect(
      formatSendActionLabel({
        ...idleSendLabelInput,
        sendDisabledReason: "Messages loading",
        isConnecting: true,
      }),
    ).toBe("Messages loading");
  });

  it("reports connecting, preparing worktree, and sending in that order", () => {
    expect(formatSendActionLabel({ ...idleSendLabelInput, isConnecting: true })).toBe("Connecting");
    expect(formatSendActionLabel({ ...idleSendLabelInput, isPreparingWorktree: true })).toBe(
      "Preparing worktree",
    );
    expect(formatSendActionLabel({ ...idleSendLabelInput, isSendBusy: true })).toBe("Sending");
  });
});

describe("formatPendingPrimaryActionLabel", () => {
  it("returns 'Submitting...' while responding", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submitting...' while responding regardless of other flags", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: true,
        questionIndex: 3,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submit' in compact mode on the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit");
  });

  it("returns 'Next' in compact mode when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Next");
  });

  it("returns 'Next question' when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Next question");
  });

  it("returns singular 'Submit answer' on the last question when it is the only question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit answer");
  });

  it("returns plural 'Submit answers' on the last question when there are multiple questions", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Submit answers");
  });

  it("returns plural 'Submit answers' for higher question indices", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 5,
      }),
    ).toBe("Submit answers");
  });
});
