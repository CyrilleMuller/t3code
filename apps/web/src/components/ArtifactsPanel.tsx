/**
 * Custom right-panel surface: the pages a thread produced, newest first, derived on render.
 * A row opens its link where "Open links in" says, or the written file in the file preview
 * when the thread never linked it.
 */
import {
  artifactSourcesFromProjection,
  deriveThreadArtifacts,
  htmlDocumentTitle,
  type ThreadArtifact,
} from "@t3tools/client-runtime/thread-artifacts";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { ExternalLink, LayoutTemplate } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { canOpenLinksInApp } from "~/browser/browserLinkTarget";
import { useOpenLink } from "~/browser/useOpenLink";
import { useClientSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { useQuietThreadProjection } from "~/state/entities";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "~/timestampFormat";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
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

function ArtifactRow(props: {
  artifact: ThreadArtifact;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  inAppBrowser: boolean;
  onOpen: (artifact: ThreadArtifact, event: ReactMouseEvent) => void;
  onOpenInBrowser: (url: string) => void;
}) {
  const { artifact } = props;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const sourcePath = titleSourcePath(artifact, props.cwd);
  const file = useProjectFileQuery(
    props.environmentId,
    props.cwd ?? "",
    sourcePath,
    sourcePath !== null,
  );
  const htmlTitle = file.data ? htmlDocumentTitle(file.data.contents) : null;
  const title =
    htmlTitle ??
    artifact.label ??
    (artifact.kind === "external" ? "Claude artifact" : artifact.fileName);
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
      {artifact.url && props.inAppBrowser ? (
        <span className="absolute top-1.5 right-1.5 opacity-0 group-hover/artifact:opacity-100 group-focus-within/artifact:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Open in system browser"
                  size="icon-xs"
                  variant="ghost-muted"
                  onClick={() => props.onOpenInBrowser(artifact.url!)}
                />
              }
            >
              <ExternalLink className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Open in system browser</TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
    </li>
  );
}

export function ArtifactsPanel(props: { threadRef: ScopedThreadRef; cwd: string | undefined }) {
  const { threadRef, cwd } = props;
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const artifacts = projection
    ? deriveThreadArtifacts(artifactSourcesFromProjection(projection))
    : [];
  const openLink = useOpenLink(threadRef);
  const inAppBrowser = canOpenLinksInApp(threadRef);

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
    if (artifact.url) {
      void openLink(artifact.url, { event }).catch(reportOpenFailure);
      return;
    }
    if (artifact.filePath) {
      useRightPanelStore
        .getState()
        .openFile(
          threadRef,
          workspaceRelativeFilePath(artifact.filePath, cwd) ?? artifact.filePath,
        );
    }
  };
  const openInBrowser = (url: string) => {
    void openLink(url, { event: { metaKey: true, ctrlKey: true } }).catch(reportOpenFailure);
  };

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
            inAppBrowser={inAppBrowser}
            onOpen={open}
            onOpenInBrowser={openInBrowser}
          />
        ))}
      </ul>
    </ScrollArea>
  );
}
