/**
 * The pages a thread produced, for the Artifacts panel.
 *
 * Derived from what the client already holds, with no stored state:
 * - HTML files the agent wrote or edited (file-change tool activity), and
 * - links in assistant messages that point at those pages, at a private page
 *   on the tailnet (`*.ts.net`), or at a claude.ai artifact.
 *
 * A written page under a `pages/` folder counts even when no message links
 * it. Other written HTML only counts once a message links it, so a coding
 * thread that edits `index.html` does not fill the list.
 *
 * @module threadArtifacts
 */
import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";

export interface ThreadArtifact {
  /** The URL for a linked artifact, `file:<path>` for a page with no link. */
  readonly id: string;
  /** `page` is an HTML page; `external` a claude.ai artifact. */
  readonly kind: "page" | "external";
  /** The http(s) link the thread gave, if any. */
  readonly url: string | null;
  /** The file the thread wrote, as the tool reported it (often absolute). */
  readonly filePath: string | null;
  /** The text of the markdown link, when it says more than the file name. */
  readonly label: string | null;
  /** The last path segment of the URL or of the file. */
  readonly fileName: string;
  /** The last write of the file or the last message that linked it. */
  readonly updatedAt: string;
}

type ArtifactMessage = Pick<OrchestrationMessage, "role" | "text" | "createdAt">;
type ArtifactActivity = Pick<OrchestrationThreadActivity, "kind" | "payload" | "createdAt">;

interface MessageLink {
  readonly url: string;
  readonly label: string | null;
}

const HTML_PATH_PATTERN = /\.html?$/i;
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/g;
const TRAILING_URL_PUNCTUATION = /[.,;:!?*_~]+$/;

const linksByMessageText = new Map<string, ReadonlyArray<MessageLink>>();
const LINK_CACHE_LIMIT = 500;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

function normalizeUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.replace(TRAILING_URL_PUNCTUATION, ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function urlFileName(url: URL): string {
  try {
    return decodeURIComponent(lastSegment(url.pathname));
  } catch {
    return lastSegment(url.pathname);
  }
}

/** Links in one message, markdown links first so their label wins. */
export function extractMessageLinks(text: string): ReadonlyArray<MessageLink> {
  const cached = linksByMessageText.get(text);
  if (cached) return cached;
  const links: MessageLink[] = [];
  const seen = new Set<string>();
  const push = (raw: string, label: string | null) => {
    const url = normalizeUrl(raw);
    if (!url || seen.has(url.href)) return;
    seen.add(url.href);
    links.push({ url: url.href, label });
  };
  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    push(match[2]!, asTrimmedString(match[1]!.replace(/[`*_]/g, "")));
  }
  for (const match of text.matchAll(BARE_URL_PATTERN)) {
    push(match[0], null);
  }
  // Streaming rewrites the newest message many times; old texts are dropped.
  if (linksByMessageText.size >= LINK_CACHE_LIMIT) linksByMessageText.clear();
  linksByMessageText.set(text, links);
  return links;
}

/** Paths a successful file-change tool call wrote. */
function writtenPaths(activity: ArtifactActivity): ReadonlyArray<string> {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") return [];
  const payload = asRecord(activity.payload);
  if (payload?.itemType !== "file_change") return [];
  if (payload.status === "failed" || payload.status === "declined") return [];
  const data = asRecord(payload.data);
  if (!data) return [];
  const paths = new Set<string>();
  const add = (value: unknown) => {
    const path = asTrimmedString(value);
    if (path) paths.add(path);
  };
  if (Array.isArray(data.files)) {
    for (const file of data.files) add(asRecord(file)?.path);
  }
  const input = asRecord(data.input);
  add(input?.file_path);
  add(input?.filePath);
  add(input?.path);
  return [...paths];
}

function isUnderPagesFolder(path: string): boolean {
  return /(?:^|[\\/])pages[\\/][^\\/]+$/.test(path);
}

function isClaudeArtifactUrl(url: URL): boolean {
  return (
    url.hostname === "claude.ai" &&
    (url.pathname.startsWith("/artifact/") || url.pathname.startsWith("/code/artifact/"))
  );
}

function isTailnetHost(url: URL): boolean {
  return url.hostname.endsWith(".ts.net");
}

function later(left: string, right: string): string {
  return right > left ? right : left;
}

/** Newest first. */
export function deriveThreadArtifacts(input: {
  readonly messages: ReadonlyArray<ArtifactMessage>;
  readonly activities: ReadonlyArray<ArtifactActivity>;
}): ThreadArtifact[] {
  // File name (lowercase) → the newest write of an HTML file with that name.
  const writtenByName = new Map<string, { path: string; updatedAt: string }>();
  // Every written HTML path, for pages no message links.
  const writtenByPath = new Map<string, string>();
  for (const activity of input.activities) {
    for (const path of writtenPaths(activity)) {
      if (!HTML_PATH_PATTERN.test(path)) continue;
      writtenByPath.set(path, later(writtenByPath.get(path) ?? "", activity.createdAt));
      const key = lastSegment(path).toLowerCase();
      const previous = writtenByName.get(key);
      // Prefer a page under pages/ when two folders hold the same name.
      if (
        !previous ||
        (isUnderPagesFolder(path) && !isUnderPagesFolder(previous.path)) ||
        (isUnderPagesFolder(path) === isUnderPagesFolder(previous.path) &&
          activity.createdAt >= previous.updatedAt)
      ) {
        writtenByName.set(key, { path, updatedAt: activity.createdAt });
      }
    }
  }

  const artifacts = new Map<string, ThreadArtifact>();
  const linkedPaths = new Set<string>();
  for (const message of input.messages) {
    if (message.role !== "assistant") continue;
    for (const link of extractMessageLinks(message.text)) {
      const url = new URL(link.url);
      const fileName = urlFileName(url);
      let kind: ThreadArtifact["kind"];
      let written: { path: string; updatedAt: string } | undefined;
      if (isClaudeArtifactUrl(url)) {
        kind = "external";
      } else if (HTML_PATH_PATTERN.test(url.pathname)) {
        written = writtenByName.get(fileName.toLowerCase());
        if (!written && !isTailnetHost(url)) continue;
        kind = "page";
      } else {
        continue;
      }
      if (written) linkedPaths.add(written.path);
      const label =
        link.label && link.label !== link.url && link.label !== fileName ? link.label : null;
      const previous = artifacts.get(link.url);
      artifacts.set(link.url, {
        id: link.url,
        kind,
        url: link.url,
        filePath: written?.path ?? previous?.filePath ?? null,
        label: label ?? previous?.label ?? null,
        fileName,
        updatedAt: [message.createdAt, written?.updatedAt ?? "", previous?.updatedAt ?? ""].reduce(
          later,
        ),
      });
    }
  }

  for (const [path, updatedAt] of writtenByPath) {
    if (linkedPaths.has(path) || !isUnderPagesFolder(path)) continue;
    const id = `file:${path}`;
    artifacts.set(id, {
      id,
      kind: "page",
      url: null,
      filePath: path,
      label: null,
      fileName: lastSegment(path),
      updatedAt,
    });
  }

  return [...artifacts.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

/** The `<title>` of an HTML document, whitespace collapsed, or null. */
export function htmlDocumentTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 64 * 1024));
  if (!match) return null;
  const title = match[1]!
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return title.length > 0 ? title : null;
}
