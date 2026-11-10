/**
 * The pages a thread produced: HTML it wrote under `pages/`, and links in its replies to
 * written HTML, to tailnet (`*.ts.net`) pages or to claude.ai artifacts. Other written HTML
 * counts only once a reply links it, so a thread editing `index.html` does not fill the list.
 */
import * as DateTime from "effect/DateTime";

import type { ThreadStructure } from "./state/models.ts";

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

/** A message, with `createdAt` as an ISO string so timestamps compare as text. */
export interface ArtifactMessage {
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

/** One file-change tool call that did not fail: the paths it wrote, and when. */
export interface ArtifactFileWrite {
  readonly paths: ReadonlyArray<string>;
  readonly at: string;
}

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

/** A full projection or the quiet thread structure; both carry these fields. */
type ArtifactProjection = Pick<ThreadStructure, "messages" | "turnItems">;

/**
 * What `deriveThreadArtifacts` reads, taken from a thread projection.
 *
 * Claude reports the written path as the item's `fileName` (the tool's
 * `file_path`); Codex lists them in `changes`. Failed and cancelled calls wrote
 * nothing, so they are left out.
 */
export function artifactSourcesFromProjection(projection: ArtifactProjection): {
  readonly messages: ReadonlyArray<ArtifactMessage>;
  readonly fileWrites: ReadonlyArray<ArtifactFileWrite>;
} {
  const messages = projection.messages.map((message) => ({
    role: message.role,
    text: message.text,
    createdAt: DateTime.formatIso(message.createdAt),
  }));
  const fileWrites: ArtifactFileWrite[] = [];
  for (const item of projection.turnItems) {
    if (item.type !== "file_change") continue;
    if (item.status === "failed" || item.status === "cancelled") continue;
    const paths = new Set<string>();
    const add = (value: unknown) => {
      const path = asTrimmedString(value);
      if (path) paths.add(path);
    };
    add(item.fileName);
    for (const change of item.changes ?? []) add(change.path);
    fileWrites.push({
      paths: [...paths],
      at: DateTime.formatIso(item.completedAt ?? item.updatedAt),
    });
  }
  return { messages, fileWrites };
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
  readonly fileWrites: ReadonlyArray<ArtifactFileWrite>;
}): ThreadArtifact[] {
  // File name (lowercase) → the newest write of an HTML file with that name.
  const writtenByName = new Map<string, { path: string; updatedAt: string }>();
  // Every written HTML path, for pages no message links.
  const writtenByPath = new Map<string, string>();
  for (const write of input.fileWrites) {
    for (const path of write.paths) {
      if (!HTML_PATH_PATTERN.test(path)) continue;
      writtenByPath.set(path, later(writtenByPath.get(path) ?? "", write.at));
      const key = lastSegment(path).toLowerCase();
      const previous = writtenByName.get(key);
      // Prefer a page under pages/ when two folders hold the same name.
      if (
        !previous ||
        (isUnderPagesFolder(path) && !isUnderPagesFolder(previous.path)) ||
        (isUnderPagesFolder(path) === isUnderPagesFolder(previous.path) &&
          write.at >= previous.updatedAt)
      ) {
        writtenByName.set(key, { path, updatedAt: write.at });
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
