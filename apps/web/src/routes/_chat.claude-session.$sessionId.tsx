// custom: /claude-session/<id> opens that Claude Code session as a thread of this server (pandora
// fork). The server finds the thread bound to the session, or imports the transcript once.
import { CLAUDE_SESSION_OPEN_WS_METHOD, ClaudeSessionId } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";

import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { connectionAtomRuntime } from "../connection/runtime";
import { isElectron } from "../env";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";

const isClaudeSessionId = Schema.is(ClaudeSessionId);

const openClaudeSessionCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:custom:claude-session:open",
  tag: CLAUDE_SESSION_OPEN_WS_METHOD,
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId, input }) => `${environmentId}:${input.sessionId}`,
  },
});

function ClaudeSessionRouteView() {
  const { sessionId } = Route.useParams();
  const environmentId = usePrimaryEnvironmentId();
  // A link opened in a new tab arrives before the socket is up; asking then fails with
  // "<environment> is not connected", so wait for the connection.
  const connectedIds = useConnectedEnvironmentIds();
  const connected = environmentId !== null && connectedIds.includes(environmentId);
  const navigate = useNavigate();
  const openClaudeSession = useAtomCommand(openClaudeSessionCommand, { reportFailure: false });
  const startedRef = useRef<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const validId = isClaudeSessionId(sessionId);
  const error = validId ? failure : `“${sessionId}” is not a Claude Code session id.`;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for the session's thread once the environment is known, then leaves this page
  useEffect(() => {
    const request = `${environmentId}:${sessionId}`;
    if (!validId || environmentId === null || !connected || startedRef.current === request) return;
    startedRef.current = request;
    void openClaudeSession({ environmentId, input: { sessionId } }).then((result) => {
      if (result._tag === "Success") {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: result.value.threadId },
          replace: true,
        });
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      setFailure(cause instanceof Error ? cause.message : "The server could not open it.");
    });
  }, [connected, environmentId, navigate, openClaudeSession, sessionId, validId]);

  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, "Home")}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          {error === null ? (
            <>
              <Spinner />
              <EmptyTitle>Opening Claude session</EmptyTitle>
              <EmptyDescription>{sessionId}</EmptyDescription>
            </>
          ) : (
            <>
              <EmptyTitle>Couldn’t open Claude session</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
            </>
          )}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/claude-session/$sessionId")({
  component: ClaudeSessionRouteView,
});
