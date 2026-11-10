/**
 * Custom right-panel surface: the pages a thread produced, newest first, derived on render.
 * A row opens its page in a sandboxed frame in the panel. A claude.ai artifact cannot be
 * framed, so it opens where "Open links in" says.
 */
import {
  artifactSourcesFromProjection,
  deriveThreadArtifacts,
  htmlDocumentTitle,
  type ThreadArtifact,
} from "@t3tools/client-runtime/thread-artifacts";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { ChevronLeft, ExternalLink, LayoutTemplate } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { useOpenLink } from "~/browser/useOpenLink";
import { useClientSettings } from "~/hooks/useSettings";
import { useQuietThreadProjection } from "~/state/entities";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "~/timestampFormat";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { useProjectFileQuery } from "./files/projectFilesQueryState";

/**
 * Where the page's HTML can be read for its `<title>`: the written file, or by
 * our convention `pages/<name>` in the workspace for a linked page.
 */
function titleSourcePath(artifact: ThreadArtifact, cwd: string | undefined): string | null {
  if (!cwd || artifact.kind !== "page") return null;
  if (artifact.filePath) return workspaceRelativeFilePath(artifact.filePath, cwd);
  return `pages/${artifact.fileName}`;
}

function useArtifactTitle(
  artifact: ThreadArtifact,
  environmentId: EnvironmentId,
  cwd: string | undefined,
): string {
  const sourcePath = titleSourcePath(artifact, cwd);
  const file = useProjectFileQuery(environmentId, cwd ?? "", sourcePath, sourcePath !== null);
  const htmlTitle = file.data ? htmlDocumentTitle(file.data.contents) : null;
  return (
    htmlTitle ??
    artifact.label ??
    (artifact.kind === "external" ? "Claude artifact" : artifact.fileName)
  );
}

/** Only an http(s) page or a written file can be shown in the panel. */
const canEmbed = (artifact: ThreadArtifact) => artifact.kind === "page";

function OpenInBrowserButton(props: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Open in browser"
            size="icon-xs"
            variant="ghost-muted"
            onClick={props.onClick}
          />
        }
      >
        <ExternalLink className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">Open in browser</TooltipPopup>
    </Tooltip>
  );
}

function ArtifactRow(props: {
  artifact: ThreadArtifact;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  onOpen: (artifact: ThreadArtifact, event: ReactMouseEvent) => void;
  onOpenInBrowser: (url: string) => void;
}) {
  const { artifact } = props;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const title = useArtifactTitle(artifact, props.environmentId, props.cwd);
  const location = artifact.url ?? artifact.filePath ?? "";
  return (
    <li className="group/artifact relative">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={(event) => props.onOpen(artifact, event)}
              className="flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/40"
            />
          }
        >
          <LayoutTemplate aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm">{title}</span>
            <span className="truncate text-xs text-muted-foreground">
              {artifact.kind === "external" || !artifact.url
                ? (artifact.filePath ?? new URL(artifact.url!).host)
                : artifact.fileName}
              {" · "}
              <time dateTime={artifact.updatedAt}>
                {formatDayAwareTimestamp(artifact.updatedAt, timestampFormat)}
              </time>
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left" className="max-w-80">
          <span className="block break-all">{location}</span>
          <span className="block text-muted-foreground">
            Updated {formatChatTimestampTooltip(artifact.updatedAt, timestampFormat)}
          </span>
        </TooltipPopup>
      </Tooltip>
      {artifact.url && canEmbed(artifact) ? (
        <span className="absolute top-1.5 right-1.5 opacity-0 group-hover/artifact:opacity-100 group-focus-within/artifact:opacity-100">
          <OpenInBrowserButton onClick={() => props.onOpenInBrowser(artifact.url!)} />
        </span>
      ) : null}
    </li>
  );
}

/**
 * The page runs sandboxed. A page on another origin than the app keeps its own
 * origin, so its storage works; a page served from the app's origin (a written
 * file) gets an opaque one, so it cannot reach the app's session or storage.
 */
function ArtifactFrame(props: { src: string; title: string }) {
  let sameOrigin = true;
  try {
    sameOrigin = new URL(props.src, window.location.href).origin === window.location.origin;
  } catch {
    // An unparsable URL stays fully sandboxed.
  }
  const sandbox = `allow-scripts allow-forms allow-popups allow-modals allow-downloads${
    sameOrigin ? "" : " allow-same-origin"
  }`;
  return (
    <iframe
      src={props.src}
      title={props.title}
      sandbox={sandbox}
      className="min-h-0 flex-1 border-0 bg-white"
    />
  );
}

function ArtifactFileFrame(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  absolutePath: string;
  title: string;
  revision: string;
}) {
  const resource = {
    _tag: "workspace-file" as const,
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
  };
  // A new revision mints a new URL, so a rewritten page is not served from cache.
  const assetUrl = useAssetUrlState(props.environmentId, resource, props.revision);
  if (assetUrl._tag === "Failure") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-destructive">
        Unable to load this page.
      </div>
    );
  }
  if (assetUrl._tag !== "Success") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Spinner size="lg" />
      </div>
    );
  }
  return <ArtifactFrame src={assetUrl.url} title={props.title} />;
}

function ArtifactViewer(props: {
  artifact: ThreadArtifact;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
  onBack: () => void;
  onOpenInBrowser: (url: string) => void;
}) {
  const { artifact, threadRef, cwd } = props;
  const title = useArtifactTitle(artifact, threadRef.environmentId, cwd);
  const absolutePath =
    artifact.filePath && cwd && !artifact.filePath.startsWith("/")
      ? `${cwd.replace(/\/+$/, "")}/${artifact.filePath}`
      : artifact.filePath;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-1.5">
        <Button
          aria-label="All artifacts"
          size="icon-xs"
          variant="ghost-muted"
          onClick={props.onBack}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        {artifact.url ? (
          <OpenInBrowserButton onClick={() => props.onOpenInBrowser(artifact.url!)} />
        ) : null}
      </header>
      {/* Keyed on the update time: a page the agent rewrote reloads. */}
      {artifact.url ? (
        <ArtifactFrame
          key={`${artifact.id}:${artifact.updatedAt}`}
          src={artifact.url}
          title={title}
        />
      ) : absolutePath ? (
        <ArtifactFileFrame
          key={`${artifact.id}:${artifact.updatedAt}`}
          environmentId={threadRef.environmentId}
          threadRef={threadRef}
          absolutePath={absolutePath}
          title={title}
          revision={artifact.updatedAt}
        />
      ) : null}
    </div>
  );
}

export function ArtifactsPanel(props: { threadRef: ScopedThreadRef; cwd: string | undefined }) {
  const { threadRef, cwd } = props;
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const artifacts = projection
    ? deriveThreadArtifacts(artifactSourcesFromProjection(projection))
    : [];
  const [openId, setOpenId] = useState<string | null>(null);
  const openArtifact = artifacts.find((artifact) => artifact.id === openId) ?? null;
  const openLink = useOpenLink(threadRef);

  const reportOpenFailure = (error: unknown) => {
    console.error(error);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open artifact",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };
  const open = (artifact: ThreadArtifact, event: ReactMouseEvent) => {
    if (canEmbed(artifact)) {
      setOpenId(artifact.id);
      return;
    }
    if (artifact.url) void openLink(artifact.url, { event }).catch(reportOpenFailure);
  };
  // The modifier sends the link past the in-app browser to the system browser.
  const openInBrowser = (url: string) => {
    void openLink(url, { event: { metaKey: true, ctrlKey: true } }).catch(reportOpenFailure);
  };

  if (openArtifact) {
    return (
      <ArtifactViewer
        artifact={openArtifact}
        threadRef={threadRef}
        cwd={cwd}
        onBack={() => setOpenId(null)}
        onOpenInBrowser={openInBrowser}
      />
    );
  }

  if (artifacts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <LayoutTemplate aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No artifacts yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          Pages this thread writes or links show up here.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul className="flex flex-col gap-0.5 p-2">
        {artifacts.map((artifact) => (
          <ArtifactRow
            key={artifact.id}
            artifact={artifact}
            environmentId={threadRef.environmentId}
            cwd={cwd}
            onOpen={open}
            onOpenInBrowser={openInBrowser}
          />
        ))}
      </ul>
    </ScrollArea>
  );
}
