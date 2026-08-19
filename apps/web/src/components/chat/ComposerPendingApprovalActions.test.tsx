import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

const requestId = ApprovalRequestId.make("approval-1");

function renderActions(hideSessionAllow = false) {
  return renderToStaticMarkup(
    <ComposerPendingApprovalActions
      requestId={requestId}
      isResponding={false}
      hideSessionAllow={hideSessionAllow}
      onRespondToApproval={async () => undefined}
    />,
  );
}

describe("ComposerPendingApprovalActions", () => {
  it("shows Always allow this session by default", () => {
    const markup = renderActions();

    expect(markup).toContain("Always allow this session");
    expect(markup).toContain("Approve once");
    expect(markup).toContain("Decline");
    expect(markup).toContain("Cancel turn");
  });

  it("hides Always allow this session when hideSessionAllow is set", () => {
    const markup = renderActions(true);

    expect(markup).not.toContain("Always allow this session");
    expect(markup).toContain("Approve once");
    expect(markup).toContain("Decline");
    expect(markup).toContain("Cancel turn");
  });
});
