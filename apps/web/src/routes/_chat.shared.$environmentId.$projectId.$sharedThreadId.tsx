import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { SharedChatView } from "../components/team/SharedChatView";
export const Route = createFileRoute("/_chat/shared/$environmentId/$projectId/$sharedThreadId")({
  component: () => {
    const params = Route.useParams();
    return (
      <SharedChatView
        environmentId={EnvironmentId.make(params.environmentId)}
        projectId={ProjectId.make(params.projectId)}
        threadId={ThreadId.make(params.sharedThreadId)}
      />
    );
  },
});
