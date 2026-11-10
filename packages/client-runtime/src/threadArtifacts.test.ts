import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadArtifacts,
  extractMessageLinks,
  htmlDocumentTitle,
} from "./threadArtifacts.ts";

const PAGES_URL = "https://pandora.tail3193e2.ts.net:8460/jessica";

function assistant(text: string, createdAt: string) {
  return { role: "assistant" as const, text, createdAt };
}

function write(path: string, createdAt: string, status = "completed") {
  return {
    kind: "tool.completed",
    createdAt,
    payload: {
      itemType: "file_change",
      status,
      data: { toolName: "Write", files: [{ path }] },
    },
  };
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
      activities: [write("/srv/people/jessica/pages/cube-e-bike.html", "2026-11-10T10:00:00Z")],
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
      activities: [
        write("/w/pages/a.html", "2026-11-10T10:00:00Z"),
        write("/w/pages/a.html", "2026-11-10T12:00:00Z"),
      ],
      messages: [assistant(`${PAGES_URL}/a.html`, "2026-11-10T10:01:00Z")],
    });
    expect(artifact?.updatedAt).toBe("2026-11-10T12:00:00Z");
  });

  it("lists a page under pages/ that no message links, and skips other unlinked html", () => {
    const artifacts = deriveThreadArtifacts({
      activities: [
        write("/w/pages/draft.html", "2026-11-10T10:00:00Z"),
        write("/w/apps/web/index.html", "2026-11-10T10:00:00Z"),
      ],
      messages: [],
    });
    expect(artifacts.map((artifact) => [artifact.id, artifact.url])).toEqual([
      ["file:/w/pages/draft.html", null],
    ]);
  });

  it("ignores failed writes and tools that only read", () => {
    const artifacts = deriveThreadArtifacts({
      activities: [
        write("/w/pages/failed.html", "2026-11-10T10:00:00Z", "failed"),
        {
          kind: "tool.completed",
          createdAt: "2026-11-10T10:00:00Z",
          payload: {
            itemType: "dynamic_tool_call",
            data: { files: [{ path: "/w/pages/read.html" }] },
          },
        },
      ],
      messages: [],
    });
    expect(artifacts).toEqual([]);
  });

  it("keeps tailnet pages and claude.ai artifacts, and skips other web links", () => {
    const artifacts = deriveThreadArtifacts({
      activities: [],
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
      activities: [write("/w/site/report.html", "2026-11-10T10:00:00Z")],
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
      activities: [],
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
