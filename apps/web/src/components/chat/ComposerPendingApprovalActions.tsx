import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
} from "@t3tools/contracts";
import { memo } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  /** Hidden on Grok: session-allow cancels the turn (pingdotgg/t3code#6502). */
  hideSessionAllow?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const APPROVAL_ACTION_CLASS_NAME = "font-normal";
const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  hideSessionAllow = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const visibleOptions = options.filter(
    (option) =>
      !(
        hideSessionAllow &&
        (option.decision === "acceptForSession" || option.decision === "acceptAlways")
      ),
  );
  return (
    <>
      {visibleOptions.map((option) => (
        <Button
          key={option.decision}
          size="micro"
          variant="ghost-muted"
          className={`${APPROVAL_ACTION_CLASS_NAME}${
            option.decision === "decline"
              ? " text-destructive-foreground [:hover,[data-pressed]]:text-destructive-foreground"
              : option.decision === "accept" ||
                  option.decision === "acceptForSession" ||
                  option.decision === "acceptAlways"
                ? " text-foreground"
                : ""
          }`}
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, option.decision)}
        >
          <span className="max-w-40 truncate">{option.label}</span>
        </Button>
      ))}
    </>
  );
});
