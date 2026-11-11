// custom: opens a Claude Code session as a T3 thread, for /claude-session/<id> links (pandora fork).
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const CLAUDE_SESSION_OPEN_WS_METHOD = "custom.claudeSession.open";

export const ClaudeSessionId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);

export const ClaudeSessionOpenInput = Schema.Struct({ sessionId: ClaudeSessionId });
export type ClaudeSessionOpenInput = typeof ClaudeSessionOpenInput.Type;

export const ClaudeSessionOpenResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  imported: Schema.Boolean,
});
export type ClaudeSessionOpenResult = typeof ClaudeSessionOpenResult.Type;

export class ClaudeSessionOpenError extends Schema.TaggedError<ClaudeSessionOpenError>()(
  "ClaudeSessionOpenError",
  {
    reason: Schema.Literals(["not_found", "empty", "unavailable", "failed"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const WsClaudeSessionOpenRpc = Rpc.make(CLAUDE_SESSION_OPEN_WS_METHOD, {
  payload: ClaudeSessionOpenInput,
  success: ClaudeSessionOpenResult,
  error: Schema.Union([ClaudeSessionOpenError, EnvironmentAuthorizationError]),
});
