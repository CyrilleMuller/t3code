import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadStructure } from "./state/models.ts";
import {
  artifactSourcesFromProjection,
  deriveThreadArtifacts,
  extractMessageLinks,
  htmlDocumentTitle,
} from "./threadArtifacts.ts";

const PAGES_URL = "https://pandora.tail3193e2.ts.net:8460/jessica";

function assistant(text: string, createdAt: string) {
  return { role: "assistant" as const, text, createdAt };
}

function write(path: string, at: string) {
  return { paths: [path], at };
}

describe("extractMessageLinks", () => {
  it("keeps the markdown label and drops trailing punctuation and fragments", () => {
    expect(
      extractMessageLinks(
        `Here: [Bike trailers](${PAGES_URL}/bike-trailers.html). Also ${PAGES_URL}/loan.html#top, done.`,
      ),
    ).toEqual([
      { url: `${PAGES_URL}/bike-trailers.html`, label: "Bike trailers" },
      { url: `${PAGES_URL}/loan.html`, label: null },
    ]);
  });
});

describe("deriveThreadArtifacts", () => {
  it("joins a written page with the link to it", () => {
    const artifacts = deriveThreadArtifacts({
      fileWrites: [write("/srv/people/jessica/pages/cube-e-bike.html", "2026-11-10T10:00:00Z")],
      messages: [
        assistant(
          `Done: [cube-e-bike.html](${PAGES_URL}/cube-e-bike.html)`,
          "2026-11-10T10:01:00Z",
        ),
      ],
    });
    expect(artifacts).toEqual([
      {
        id: `${PAGES_URL}/cube-e-bike.html`,
        kind: "page",
        url: `${PAGES_URL}/cube-e-bike.html`,
        filePath: "/srv/people/jessica/pages/cube-e-bike.html",
        label: null,
        fileName: "cube-e-bike.html",
        updatedAt: "2026-11-10T10:01:00Z",
      },
    ]);
  });

  it("takes the newest write as the update time", () => {
    const [artifact] = deriveThreadArtifacts({
      fileWrites: [
        write("/w/pages/a.html", "2026-11-10T10:00:00Z"),
        write("/w/pages/a.html", "2026-11-10T12:00:00Z"),
      ],
      messages: [assistant(`${PAGES_URL}/a.html`, "2026-11-10T10:01:00Z")],
    });
    expect(artifact?.updatedAt).toBe("2026-11-10T12:00:00Z");
  });

  it("lists a page under pages/ that no message links, and skips other unlinked html", () => {
    const artifacts = deriveThreadArtifacts({
      fileWrites: [
        write("/w/pages/draft.html", "2026-11-10T10:00:00Z"),
        write("/w/apps/web/index.html", "2026-11-10T10:00:00Z"),
      ],
      messages: [],
    });
    expect(artifacts.map((artifact) => [artifact.id, artifact.url])).toEqual([
      ["file:/w/pages/draft.html", null],
    ]);
  });

  it("keeps tailnet pages and claude.ai artifacts, and skips other web links", () => {
    const artifacts = deriveThreadArtifacts({
      fileWrites: [],
      messages: [
        assistant(
          [
            `${PAGES_URL}/old.html`,
            "https://claude.ai/artifact/abc123",
            "https://example.com/docs/index.html",
            "https://github.com/pingdotgg/t3code",
          ].join("\n"),
          "2026-11-10T10:00:00Z",
        ),
        {
          role: "user" as const,
          text: `${PAGES_URL}/mine.html`,
          createdAt: "2026-11-10T11:00:00Z",
        },
      ],
    });
    expect(artifacts.map((artifact) => [artifact.kind, artifact.url])).toEqual([
      ["page", `${PAGES_URL}/old.html`],
      ["external", "https://claude.ai/artifact/abc123"],
    ]);
  });

  it("lists a linked page the thread wrote outside pages/", () => {
    const [artifact] = deriveThreadArtifacts({
      fileWrites: [write("/w/site/report.html", "2026-11-10T10:00:00Z")],
      messages: [
        assistant("[Q3 report](http://localhost:4173/report.html)", "2026-11-10T10:01:00Z"),
      ],
    });
    expect(artifact).toMatchObject({
      url: "http://localhost:4173/report.html",
      filePath: "/w/site/report.html",
      label: "Q3 report",
    });
  });

  it("orders newest first", () => {
    const artifacts = deriveThreadArtifacts({
      fileWrites: [],
      messages: [
        assistant(`${PAGES_URL}/first.html`, "2026-11-10T10:00:00Z"),
        assistant(`${PAGES_URL}/second.html`, "2026-11-10T11:00:00Z"),
      ],
    });
    expect(artifacts.map((artifact) => artifact.fileName)).toEqual(["second.html", "first.html"]);
  });
});

describe("htmlDocumentTitle", () => {
  it("reads and cleans the title", () => {
    expect(htmlDocumentTitle("<html><head><title>\n  Loan &amp; ETF\n</title></head></html>")).toBe(
      "Loan & ETF",
    );
  });

  it("returns null without a title", () => {
    expect(htmlDocumentTitle("<html><title>  </title></html>")).toBeNull();
    expect(htmlDocumentTitle("<p>no head</p>")).toBeNull();
  });
});

describe("artifactSourcesFromProjection", () => {
  const time = (iso: string) => DateTime.makeUnsafe(iso);
  const fileChange = (fields: {
    fileName: string;
    status: string;
    completedAt: string | null;
    updatedAt: string;
    changes?: ReadonlyArray<{ operation: string; path: string }>;
  }) => ({
    type: "file_change" as const,
    fileName: fields.fileName,
    status: fields.status,
    completedAt: fields.completedAt === null ? null : time(fields.completedAt),
    updatedAt: time(fields.updatedAt),
    ...(fields.changes ? { changes: fields.changes } : {}),
  });
  const projection = (
    turnItems: ReadonlyArray<unknown>,
    messages: ReadonlyArray<{ role: string; text: string; createdAt: string }> = [],
  ) =>
    ({
      turnItems,
      messages: messages.map((message) => ({ ...message, createdAt: time(message.createdAt) })),
    }) as unknown as Pick<ThreadStructure, "messages" | "turnItems">;

  it("reads Claude's written path from fileName and Codex's from changes", () => {
    const sources = artifactSourcesFromProjection(
      projection([
        fileChange({
          fileName: "/w/pages/claude.html",
          status: "completed",
          completedAt: "2026-11-10T10:00:00Z",
          updatedAt: "2026-11-10T10:00:01Z",
        }),
        fileChange({
          fileName: "2 files",
          status: "completed",
          completedAt: null,
          updatedAt: "2026-11-10T11:00:00Z",
          changes: [
            { operation: "add", path: "/w/pages/codex.html" },
            { operation: "update", path: "/w/README.md" },
          ],
        }),
      ]),
    );
    expect(sources.fileWrites).toEqual([
      { paths: ["/w/pages/claude.html"], at: "2026-11-10T10:00:00.000Z" },
      {
        paths: ["2 files", "/w/pages/codex.html", "/w/README.md"],
        at: "2026-11-10T11:00:00.000Z",
      },
    ]);
  });

  it("skips failed and cancelled writes and other turn items", () => {
    const sources = artifactSourcesFromProjection(
      projection([
        fileChange({
          fileName: "/w/pages/failed.html",
          status: "failed",
          completedAt: null,
          updatedAt: "2026-11-10T10:00:00Z",
        }),
        fileChange({
          fileName: "/w/pages/cancelled.html",
          status: "cancelled",
          completedAt: null,
          updatedAt: "2026-11-10T10:00:00Z",
        }),
        { type: "command_execution", input: "cat /w/pages/read.html", status: "completed" },
      ]),
    );
    expect(sources.fileWrites).toEqual([]);
  });

  it("feeds deriveThreadArtifacts end to end", () => {
    const artifacts = deriveThreadArtifacts(
      artifactSourcesFromProjection(
        projection(
          [
            fileChange({
              fileName: "/srv/people/jessica/pages/loan.html",
              status: "completed",
              completedAt: "2026-11-10T10:00:00Z",
              updatedAt: "2026-11-10T10:00:00Z",
            }),
          ],
          [
            {
              role: "assistant",
              text: `[Loan](${PAGES_URL}/loan.html)`,
              createdAt: "2026-11-10T10:01:00Z",
            },
          ],
        ),
      ),
    );
    expect(artifacts).toEqual([
      {
        id: `${PAGES_URL}/loan.html`,
        kind: "page",
        url: `${PAGES_URL}/loan.html`,
        filePath: "/srv/people/jessica/pages/loan.html",
        label: "Loan",
        fileName: "loan.html",
        updatedAt: "2026-11-10T10:01:00.000Z",
      },
    ]);
  });
});
