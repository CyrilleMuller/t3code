import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeSessionLink from "./ClaudeSessionLink.ts";
import { claudeHomes, importTitle, transcriptCwd } from "./claudeSessionLink.logic.ts";

const SESSION_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const CWD = "/work/app";
const projectId = ProjectId.make("claude-session-project");
const timestamp = "2026-11-01T10:00:00.000Z";

const record = (value: Record<string, unknown>) => JSON.stringify(value);
const chain = { sessionId: SESSION_ID, cwd: CWD, isSidechain: false, timestamp };

// The record kinds a headless `claude -p` run writes, with the ones T3 must not show.
const TRANSCRIPT = [
  record({ type: "session-owner", sessionId: SESSION_ID }),
  record({
    ...chain,
    type: "user",
    uuid: "u1",
    parentUuid: null,
    message: { role: "user", content: "  Fix the login bug\nin auth.ts  " },
  }),
  record({
    ...chain,
    type: "user",
    uuid: "m1",
    isMeta: true,
    message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" },
  }),
  record({
    ...chain,
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      model: "claude-opus-4-6",
      content: [
        { type: "thinking", thinking: "Where is auth.ts?" },
        { type: "text", text: "Looking at auth.ts." },
      ],
    },
  }),
  record({
    ...chain,
    type: "assistant",
    uuid: "a2",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "auth.ts" } }],
    },
  }),
  record({
    ...chain,
    type: "user",
    uuid: "u2",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "export {}" }],
    },
  }),
  record({
    ...chain,
    type: "assistant",
    uuid: "s1",
    isSidechain: true,
    message: { role: "assistant", content: [{ type: "text", text: "Subagent report" }] },
  }),
  record({ ...chain, type: "system", uuid: "y1", subtype: "informational", content: "Hook ran" }),
  "not json",
  record({
    ...chain,
    type: "assistant",
    uuid: "a3",
    message: { role: "assistant", content: [{ type: "text", text: "Fixed it." }] },
  }),
  record({ type: "last-prompt", sessionId: SESSION_ID, lastPrompt: "Fix the login bug" }),
].join("\n");

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  IdAllocator.layer,
  NodeServices.layer,
);

const setup = Effect.fn("ClaudeSessionLink.test.setup")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-session-link-" });
  const projectDir = path.join(home, ".claude", "projects", "-work-app");
  yield* fileSystem.makeDirectory(projectDir, { recursive: true });
  yield* fileSystem.writeFileString(path.join(projectDir, `${SESSION_ID}.jsonl`), TRANSCRIPT);
  const bootstrapped: Array<string> = [];
  const context = yield* Layer.build(
    ClaudeSessionLink.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(EventSink.EventSinkV2, yield* EventSink.EventSinkV2),
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          ServerSettings.layerTest(),
          Layer.mock(ProjectService.ProjectService)({
            bootstrap: (input) =>
              Effect.sync(() => {
                bootstrapped.push(input.workspaceRoot);
                return {
                  project: {
                    id: projectId,
                    title: input.title,
                    workspaceRoot: input.workspaceRoot,
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: timestamp,
                    updatedAt: timestamp,
                    deletedAt: null,
                  },
                  created: true,
                };
              }),
          }),
        ),
      ),
    ),
  );
  const link = Context.get(context, ClaudeSessionLink.ClaudeSessionLink);
  const open = (sessionId: string) =>
    link
      .open({ sessionId })
      .pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {}),
      );
  return { open, bootstrapped };
});

const seedNativeThread = Effect.fn("ClaudeSessionLink.test.seedNativeThread")(function* (
  sessionId: string,
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const now = DateTime.makeUnsafe(timestamp);
  const driver = ProviderDriverKind.make("claudeAgent");
  const providerInstanceId = ProviderInstanceId.make("claudeAgent");
  const threadId = ThreadId.make("t3-native-thread");
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({ driver, providerInstanceId, nativeThreadId: sessionId }),
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: sessionId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("native-project"),
    title: "Started in T3",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "claude-sonnet-4-6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

describe("ClaudeSessionLink", () => {
  it.effect("imports a transcript once, with its user and assistant text only", () =>
    Effect.gen(function* () {
      const { open, bootstrapped } = yield* setup();
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const first = yield* open(SESSION_ID.toUpperCase());
      const threadId = ThreadId.make(`import:claudeAgent:${SESSION_ID}`);
      expect(first).toEqual({ threadId, projectId, imported: true });
      expect(bootstrapped).toEqual([CWD]);

      const records = yield* projections.getThreadRecords(threadId, [
        "messages",
        "providerThreads",
      ]);
      expect(records.thread.title).toBe("Fix the login bug");
      expect(records.thread.modelSelection.model).toBe("claude-opus-4-6");
      expect(records.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "Fix the login bug\nin auth.ts" },
        { role: "assistant", text: "Looking at auth.ts." },
        { role: "assistant", text: "Fixed it." },
      ]);
      expect(records.providerThreads).toHaveLength(1);
      expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(SESSION_ID);
      expect(records.thread.activeProviderThreadId).toBe(records.providerThreads[0]?.id);

      expect(yield* open(SESSION_ID)).toEqual({ threadId, projectId, imported: false });
      expect(bootstrapped).toEqual([CWD]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
  );

  it.effect("opens the T3 thread already bound to the session instead of importing it", () =>
    Effect.gen(function* () {
      const { open, bootstrapped } = yield* setup();
      const threadId = yield* seedNativeThread(SESSION_ID);
      expect(yield* open(SESSION_ID)).toEqual({
        threadId,
        projectId: ProjectId.make("native-project"),
        imported: false,
      });
      expect(bootstrapped).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
  );

  it.effect("fails for a session without a transcript and creates nothing", () =>
    Effect.gen(function* () {
      const { open, bootstrapped } = yield* setup();
      const events = yield* EventStore.EventStoreV2;
      const missing = "00000000-0000-4000-8000-000000000000";
      const error = yield* Effect.flip(open(missing));
      expect(error).toMatchObject({ _tag: "ClaudeSessionOpenError", reason: "not_found" });
      expect(bootstrapped).toEqual([]);
      expect(
        yield* events
          .read({ threadId: ThreadId.make(`import:claudeAgent:${missing}`) })
          .pipe(Stream.runCollect),
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
  );
});

describe("claudeSessionLink logic", () => {
  it("takes the working directory from the first record that has one", () => {
    expect(transcriptCwd(TRANSCRIPT)).toBe(CWD);
    expect(transcriptCwd(record({ type: "session-owner" }))).toBeNull();
  });

  it("titles a prompt that opens with front matter by its first line with words", () => {
    const thread = {
      source: "claudeAgent" as const,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      providerSessionId: "session",
      title: "---",
      model: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [
        {
          role: "user" as const,
          text: "---\nname: nightly\n---\nCheck the backups",
          createdAt: timestamp,
        },
      ],
      omittedMessageCount: 0,
    };
    expect(importTitle(thread)).toBe("Check the backups");
    expect(importTitle({ ...thread, title: "Nightly backup check" })).toBe("Nightly backup check");
  });

  it("searches the default instance first and honours CLAUDE_CONFIG_DIR", () => {
    const resolve = (...segments: ReadonlyArray<string>) => segments.join("/");
    expect(
      claudeHomes({
        providerInstances: {
          work: {
            driver: ProviderDriverKind.make("claudeAgent"),
            environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/srv/claude-work" }],
          },
        },
        hostEnvironment: {},
        homeDir: "/home/me",
        resolve,
      }),
    ).toEqual([
      { homePath: "/home/me/.claude", providerInstanceId: "claudeAgent" },
      { homePath: "/srv/claude-work", providerInstanceId: "work" },
    ]);
  });
});
