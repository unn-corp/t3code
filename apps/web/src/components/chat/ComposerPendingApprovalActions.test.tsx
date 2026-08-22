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
  it("states that the persistent approval lasts for this session", () => {
    const markup = renderActions();

    expect(markup).toContain(">Cancel<");
    expect(markup).toContain("Always allow this session");
    expect(markup).not.toContain(">Always allow<");
    expect(markup).toContain("h-5");
    expect(markup).toContain("sm:text-[11px]");
    expect(markup).not.toContain("sm:h-6");
  });

  it("hides Always allow this session when hideSessionAllow is set", () => {
    const markup = renderActions(true);

    expect(markup).not.toContain("Always allow this session");
    expect(markup).toContain(">Cancel<");
    expect(markup).toContain("Decline");
  });
});
