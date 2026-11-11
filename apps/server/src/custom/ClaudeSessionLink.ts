// custom: opens a Claude Code session as a T3 thread, for /claude-session/<id> links (pandora fork).
// A thread already bound to the session wins; otherwise the transcript is imported once.
import {
  ClaudeSessionOpenError,
  CommandId,
  DEFAULT_RUNTIME_MODE,
  isRuntimeModeAbove,
  ProjectId,
  ThreadId,
  type ClaudeSessionOpenInput,
  type ClaudeSessionOpenResult,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import { parseAgentSessionTranscript } from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  CLAUDE_DRIVER,
  claudeHomes,
  claudeSessionImportEvents,
  importedClaudeThreadId,
  transcriptCwd,
} from "./claudeSessionLink.logic.ts";

const failure = (reason: ClaudeSessionOpenError["reason"], detail: string) =>
  new ClaudeSessionOpenError({ reason, detail });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const sessionLocks = yield* KeyedLock.make<string>();

  const boundThread = (sessionId: string) =>
    sql<{ readonly thread_id: string; readonly project_id: string }>`
      SELECT provider_thread.thread_id, thread.project_id
      FROM orchestration_v2_projection_provider_threads AS provider_thread
      INNER JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = provider_thread.thread_id
      WHERE provider_thread.driver = ${CLAUDE_DRIVER}
        AND json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId') = ${sessionId}
        AND thread.deleted_at IS NULL
      ORDER BY
        provider_thread.owner_node_id IS NULL DESC,
        thread.archived_at IS NULL DESC,
        provider_thread.updated_at DESC
      LIMIT 1
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => rows[0]),
    );

  const threadExists = (threadId: ThreadId) =>
    sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => rows.length > 0),
    );

  const locateTranscript = Effect.fn("ClaudeSessionLink.locateTranscript")(function* (
    sessionId: string,
  ) {
    const settings = yield* settingsService.getSettings;
    const homes = claudeHomes({
      providerInstances: settings.providerInstances,
      hostEnvironment: yield* HostProcess.Environment,
      homeDir: yield* HostProcess.HomeDirectory,
      resolve: (...segments) => path.resolve(...segments),
    });
    for (const home of homes) {
      const projectsDir = path.join(home.homePath, "projects");
      const projectDirs = yield* fileSystem
        .readDirectory(projectsDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const projectDir of projectDirs) {
        const filePath = path.join(projectsDir, projectDir, `${sessionId}.jsonl`);
        const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
        if (Option.isSome(info) && info.value.type === "File") {
          const mtimeMs = Option.isSome(info.value.mtime)
            ? info.value.mtime.value.getTime()
            : yield* Clock.currentTimeMillis;
          return Option.some({ filePath, mtimeMs, providerInstanceId: home.providerInstanceId });
        }
      }
    }
    return Option.none();
  });

  const importSession = Effect.fn("ClaudeSessionLink.importSession")(function* (sessionId: string) {
    const located = yield* locateTranscript(sessionId);
    if (Option.isNone(located)) {
      return yield* failure("not_found", `No Claude Code transcript for session ${sessionId}.`);
    }
    const { filePath, mtimeMs, providerInstanceId } = located.value;
    const threadId = importedClaudeThreadId(providerInstanceId, sessionId);
    if (yield* threadExists(threadId)) {
      return yield* failure(
        "unavailable",
        `Claude session ${sessionId} was imported before and its thread was deleted.`,
      );
    }
    const contents = yield* fileSystem.readFileString(filePath);
    const parsed = parseAgentSessionTranscript({
      source: "claudeAgent",
      providerInstanceId,
      fallbackSessionId: sessionId,
      lastActiveAtMs: mtimeMs,
      contents,
    });
    const cwd = transcriptCwd(contents);
    if (parsed === null || cwd === null) {
      return yield* failure(
        "empty",
        `Claude session ${sessionId} has no user message or working directory to import.`,
      );
    }
    // `claude --resume` finds the session by its file name.
    const thread = { ...parsed, providerSessionId: sessionId };
    const { project } = yield* projects.bootstrap({
      commandId: CommandId.make(yield* randomUuidV4),
      projectId: ProjectId.make(yield* randomUuidV4),
      title: path.basename(cwd) || "project",
      workspaceRoot: cwd,
    });
    // As in AgentSessionImporter: full access unless a policy ceiling caps the project's default.
    const ceiling = settingsService.managedPolicy?.limits?.maxRuntimeMode;
    const runtimeMode =
      ceiling === undefined
        ? DEFAULT_RUNTIME_MODE
        : yield* settingsService.getSettings.pipe(
            Effect.map((settings) => {
              const mode = resolveProjectSettings(settings, project.id, project).settings
                .defaultRuntimeMode;
              return isRuntimeModeAbove(mode, ceiling) ? ceiling : mode;
            }),
          );
    const { providerThread, events } = claudeSessionImportEvents({
      thread,
      projectId: project.id,
      providerThreadId: idAllocator.derive.providerThread({
        driver: CLAUDE_DRIVER,
        providerInstanceId,
        nativeThreadId: sessionId,
      }),
      runtimeMode,
    });
    const committed = yield* eventSink.write({ unlessNativeThreadOwned: providerThread, events });
    if (committed.length === 0) {
      return yield* failure(
        "unavailable",
        `Claude session ${sessionId} belongs to a deleted T3 thread.`,
      );
    }
    yield* Effect.logInfo("Imported Claude session", {
      sessionId,
      threadId,
      messageCount: thread.messages.length,
      omittedMessageCount: thread.omittedMessageCount,
    });
    return { threadId, projectId: project.id, imported: true } satisfies ClaudeSessionOpenResult;
  });

  const open = Effect.fn("ClaudeSessionLink.open")(
    function* (input: ClaudeSessionOpenInput) {
      const sessionId = input.sessionId.toLowerCase();
      return yield* sessionLocks.withLock(
        sessionId,
        Effect.gen(function* () {
          const bound = yield* boundThread(sessionId);
          if (bound !== undefined) {
            return {
              threadId: ThreadId.make(bound.thread_id),
              projectId: ProjectId.make(bound.project_id),
              imported: false,
            } satisfies ClaudeSessionOpenResult;
          }
          return yield* importSession(sessionId);
        }),
      );
    },
    Effect.tapError((cause) =>
      cause._tag === "ClaudeSessionOpenError"
        ? Effect.void
        : Effect.logWarning("Could not open a Claude session", { cause }),
    ),
    Effect.mapError((cause) =>
      cause._tag === "ClaudeSessionOpenError"
        ? cause
        : failure("failed", `Could not open the Claude session: ${cause.message}`),
    ),
  );

  return { open };
});

export class ClaudeSessionLink extends Context.Service<
  ClaudeSessionLink,
  Effect.Success<typeof make>
>()("t3/custom/ClaudeSessionLink") {}

export const layer = Layer.effect(ClaudeSessionLink, make);
