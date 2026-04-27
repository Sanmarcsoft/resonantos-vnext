// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-007-living-archive-boundaries.md

import type {
  ArchiveDocumentPayload,
  ArchiveImportedLibrarySummary,
  ArchiveLibraryClassificationReview,
  ArchiveLibraryReorganisationPlan,
  ArchivePromoteReviewArtifactResult,
  ArchiveProcessIngestResult,
  ArchiveIngestProbeResult,
  ArchiveLibraryImportMode,
  ArchiveLibraryImportResult,
  ArchiveMemoryDomain,
  ArchiveQueuedIngestRequest,
  ArchiveReviewArtifact,
  ArchiveReviewDecisionResult,
  ArchiveRuntimeStatus,
  ArchiveSearchResult,
  ArchiveSearchSourceHit,
  ArchiveSourceFolderScanResult,
  ArchiveSourceWatchRecord,
  ArchiveTolBundleBuildResult,
  ArchiveTolBundleCandidate,
  ResonantShellState,
} from "../../core/contracts";
import { Panel } from "../../components/Panel";
import { ArchiveAudio2TolIntake } from "./ArchiveAudio2TolIntake";
import { ArchiveClassificationReviewPanel } from "./ArchiveClassificationReviewPanel";
import { ArchiveDiagnostics } from "./ArchiveDiagnostics";
import { ArchiveDocumentReader } from "./ArchiveDocumentReader";
import { ArchiveLibraryImporter } from "./ArchiveLibraryImporter";
import { ArchiveRecentActivity } from "./ArchiveRecentActivity";
import { ArchiveReviewDesk } from "./ArchiveReviewDesk";
import { ArchiveSearchPanel } from "./ArchiveSearchPanel";
import { ArchiveSourceScanResults } from "./ArchiveSourceScanResults";
import { ArchiveSourceRegistry } from "./ArchiveSourceRegistry";

type ArchiveWorkspaceProps = {
  state: ResonantShellState;
  archiveStatusBusy: boolean;
  archiveStatus: ArchiveRuntimeStatus | null;
  archiveSearchBusy: boolean;
  archiveSearchResult: ArchiveSearchResult | null;
  archiveDocumentBusy: boolean;
  archiveDocument: ArchiveDocumentPayload | null;
  archiveQueueBusy: boolean;
  archiveQueue: ArchiveQueuedIngestRequest[];
  archiveReviewArtifacts: ArchiveReviewArtifact[];
  archiveProcessResult: ArchiveProcessIngestResult | null;
  archiveReviewDecisionResult: ArchiveReviewDecisionResult | null;
  archivePromotionResult: ArchivePromoteReviewArtifactResult | null;
  archiveTolBundles: ArchiveTolBundleCandidate[];
  archiveTolBundleResult: ArchiveTolBundleBuildResult | null;
  archiveSourceScanBusy: boolean;
  archiveSourceScanResult: ArchiveSourceFolderScanResult | null;
  archiveImportedLibraries: ArchiveImportedLibrarySummary[];
  archiveClassificationReview: ArchiveLibraryClassificationReview | null;
  archiveReorganisationPlan: ArchiveLibraryReorganisationPlan | null;
  archiveLibraryImportResult: ArchiveLibraryImportResult | null;
  ingestProbeBusy: boolean;
  ingestProbeResult: {
    probe: ArchiveIngestProbeResult;
    routeLabel: string;
    model: string;
    resolutionReason: string;
  } | null;
  onRefreshArchiveStatus: () => void;
  onRefreshArchiveSourceRegistry: () => void;
  onRefreshArchiveQueue: () => void;
  onRunArchiveSearch: (query: string) => void;
  onOpenArchiveDocument: (path: string) => void;
  onQueueArchiveSource: (source: ArchiveSearchSourceHit) => void;
  onScanSourceFolders: (rootPath?: string) => void;
  onPickLibraryFolder: () => Promise<string | null>;
  onOpenClassificationReview: (classificationManifestPath: string) => void;
  onGenerateReorganisationPlan: (classificationManifestPath: string) => void;
  onImportLibrary: (input: {
    sourcePath: string;
    domain: ArchiveMemoryDomain;
    importMode: ArchiveLibraryImportMode;
    libraryName?: string;
  }) => void;
  onQueueWatchedSource: (source: ArchiveSourceWatchRecord) => void;
  onProcessArchiveRequest: (requestFile: string) => void;
  onApproveReviewArtifact: (artifactFile: string) => void;
  onEscalateReviewArtifact: (artifactFile: string) => void;
  onRejectReviewArtifact: (artifactFile: string) => void;
  onPromoteReviewArtifact: (artifactFile: string) => void;
  onRefreshTolBundles: () => void;
  onBuildTolBundle: (sessionId: string) => void;
  onRunIngestProbe: () => void;
};

export function ArchiveWorkspace({
  state,
  archiveStatusBusy,
  archiveStatus,
  archiveSearchBusy,
  archiveSearchResult,
  archiveDocumentBusy,
  archiveDocument,
  archiveQueueBusy,
  archiveQueue,
  archiveReviewArtifacts,
  archiveProcessResult,
  archiveReviewDecisionResult,
  archivePromotionResult,
  archiveTolBundles,
  archiveTolBundleResult,
  archiveSourceScanBusy,
  archiveSourceScanResult,
  archiveImportedLibraries,
  archiveClassificationReview,
  archiveReorganisationPlan,
  archiveLibraryImportResult,
  ingestProbeBusy,
  ingestProbeResult,
  onRefreshArchiveStatus,
  onRefreshArchiveSourceRegistry,
  onRefreshArchiveQueue,
  onRunArchiveSearch,
  onOpenArchiveDocument,
  onQueueArchiveSource,
  onScanSourceFolders,
  onPickLibraryFolder,
  onOpenClassificationReview,
  onGenerateReorganisationPlan,
  onImportLibrary,
  onQueueWatchedSource,
  onProcessArchiveRequest,
  onApproveReviewArtifact,
  onEscalateReviewArtifact,
  onRejectReviewArtifact,
  onPromoteReviewArtifact,
  onRefreshTolBundles,
  onBuildTolBundle,
  onRunIngestProbe,
}: ArchiveWorkspaceProps) {
  const archiveReady = archiveStatus?.status === "ready";
  const archiveModeLabel = archiveStatus ? `${archiveStatus.mode} mode` : "not loaded";
  const pagesTotal = archiveStatus?.stats?.pagesTotal ?? 0;
  const unprocessedSources = archiveStatus?.stats?.sourcesUnprocessed ?? 0;
  const pendingArtifacts = archiveReviewArtifacts.filter((artifact) => artifact.decision.status === "pending").length;
  const audio2TolInstallation = state.installations["addon.audio2tol"];
  const audio2TolEnabled = Boolean(audio2TolInstallation?.installed && audio2TolInstallation.enabled);

  return (
    <>
      <Panel className="archive-command-panel">
        <div className="archive-command-layout">
          <div className="archive-command-copy">
            <span className={`archive-status-dot ${archiveReady ? "ready" : "warning"}`} />
            <span className="eyebrow">Living Archive</span>
            <h2>{archiveReady ? "Archive is ready for intake and review." : "Start by loading the archive runtime."}</h2>
            <p>
              This page has three jobs: search trusted memory, collect new intake, and review proposed knowledge before it enters
              the wiki.
            </p>
          </div>
          <div className="archive-command-actions">
            <button type="button" className="button-secondary touch-action" onClick={onRefreshArchiveStatus} disabled={archiveStatusBusy}>
              {archiveStatusBusy ? "Checking..." : "Check Archive"}
            </button>
            {audio2TolEnabled ? (
              <button type="button" className="button-secondary touch-action" onClick={onRefreshTolBundles} disabled={archiveQueueBusy}>
                {archiveQueueBusy ? "Detecting..." : "Detect TOL Bundles"}
              </button>
            ) : null}
            <button type="button" className="button-secondary touch-action" onClick={onRefreshArchiveQueue} disabled={archiveQueueBusy}>
              {archiveQueueBusy ? "Refreshing..." : "Refresh Review"}
            </button>
          </div>
        </div>
        <div className="archive-help-card" aria-label="Living Archive help">
          <div>
            <span className="eyebrow">Why it matters</span>
            <p>
              The Living Archive is an AI-managed wiki for long-term memory. It turns reviewed material into organised knowledge
              so Augmentor can answer with better context without re-reading every raw file each time.
            </p>
          </div>
          <div className="archive-help-points">
            <ul>
              <li>Faster answers because useful knowledge is pre-organised before the AI needs it.</li>
              <li>Better continuity because concepts, entities, summaries, and syntheses can improve over time.</li>
              <li>Safer memory because raw intake is reviewed before it becomes trusted wiki knowledge.</li>
            </ul>
            <details className="archive-help-more">
              <summary>Read more</summary>
              <div className="archive-help-more-body">
                <p>
                  Raw notes, transcripts, documents, and add-on outputs enter the archive as intake. The ingest service interprets
                  that material and proposes structured wiki updates. Those proposals can then be approved, rejected, or escalated.
                </p>
                <p>
                  This means the archive is not just file storage. It is a maintained knowledge layer that helps the Strategist
                  retrieve the right memory quickly while keeping trusted knowledge separate from unreviewed data.
                </p>
                <ul>
                  <li>Use search to inspect what ResonantOS already knows.</li>
                  <li>Use intake when new material should become part of memory.</li>
                  <li>Use review to decide what is safe to promote into trusted knowledge.</li>
                </ul>
              </div>
            </details>
          </div>
        </div>
        <div className="archive-command-metrics" aria-label="Archive status summary">
          <ArchiveMetric label="Status" value={archiveReady ? "Archive online" : "Archive needs check"} meta={archiveModeLabel} tone={archiveReady ? "ready" : "warning"} />
          <ArchiveMetric label="Wiki Pages" value={String(pagesTotal)} meta={archiveStatus?.wikiRoot ?? "runtime not loaded"} />
          <ArchiveMetric label="Needs Work" value={String(archiveQueue.length + pendingArtifacts + unprocessedSources)} meta={`${archiveQueue.length} queued · ${pendingArtifacts} review · ${unprocessedSources} sources`} />
        </div>
      </Panel>

      <section className={`archive-primary-grid ${audio2TolEnabled ? "" : "single"}`.trim()}>
        {audio2TolEnabled ? (
          <ArchiveAudio2TolIntake
            archiveQueueBusy={archiveQueueBusy}
            archiveTolBundles={archiveTolBundles}
            archiveTolBundleResult={archiveTolBundleResult}
            onBuildTolBundle={onBuildTolBundle}
            onOpenArchiveDocument={onOpenArchiveDocument}
          />
        ) : null}

        <ArchiveSearchPanel
          archiveSearchBusy={archiveSearchBusy}
          archiveSearchResult={archiveSearchResult}
          onRunArchiveSearch={onRunArchiveSearch}
          onOpenArchiveDocument={onOpenArchiveDocument}
          onQueueArchiveSource={onQueueArchiveSource}
        />
      </section>

      <ArchiveSourceRegistry
        archiveStatus={archiveStatus}
        archiveSourceScanBusy={archiveSourceScanBusy}
        archiveSourceScanResult={archiveSourceScanResult}
        archiveImportedLibraries={archiveImportedLibraries}
        onRefreshArchiveSourceRegistry={onRefreshArchiveSourceRegistry}
        onScanSourceFolders={onScanSourceFolders}
        onOpenClassificationReview={onOpenClassificationReview}
      />
      {archiveClassificationReview ? (
        <ArchiveClassificationReviewPanel
          review={archiveClassificationReview}
          plan={archiveReorganisationPlan}
          busy={archiveSourceScanBusy}
          onGenerateReorganisationPlan={onGenerateReorganisationPlan}
        />
      ) : null}

      <ArchiveLibraryImporter
        archiveSourceScanBusy={archiveSourceScanBusy}
        archiveLibraryImportResult={archiveLibraryImportResult}
        onPickLibraryFolder={onPickLibraryFolder}
        onImportLibrary={onImportLibrary}
      />
      <ArchiveSourceScanResults
        archiveSourceScanResult={archiveSourceScanResult}
        archiveQueueBusy={archiveQueueBusy}
        onOpenArchiveDocument={onOpenArchiveDocument}
        onQueueWatchedSource={onQueueWatchedSource}
      />

      <ArchiveReviewDesk
        archiveQueueBusy={archiveQueueBusy}
        archiveQueue={archiveQueue}
        archiveReviewArtifacts={archiveReviewArtifacts}
        archiveProcessResult={archiveProcessResult}
        archiveReviewDecisionResult={archiveReviewDecisionResult}
        archivePromotionResult={archivePromotionResult}
        onRefreshArchiveQueue={onRefreshArchiveQueue}
        onProcessArchiveRequest={onProcessArchiveRequest}
        onApproveReviewArtifact={onApproveReviewArtifact}
        onEscalateReviewArtifact={onEscalateReviewArtifact}
        onRejectReviewArtifact={onRejectReviewArtifact}
        onPromoteReviewArtifact={onPromoteReviewArtifact}
      />

      <section className="archive-secondary-grid">
        <ArchiveDocumentReader archiveDocumentBusy={archiveDocumentBusy} archiveDocument={archiveDocument} />
        <ArchiveRecentActivity archiveStatus={archiveStatus} />
      </section>

      <ArchiveDiagnostics
        state={state}
        archiveStatus={archiveStatus}
        ingestProbeBusy={ingestProbeBusy}
        ingestProbeResult={ingestProbeResult}
        onRunIngestProbe={onRunIngestProbe}
      />
    </>
  );
}

function ArchiveMetric({
  label,
  value,
  meta,
  tone,
}: {
  label: string;
  value: string;
  meta: string;
  tone?: "ready" | "warning";
}) {
  return (
    <div className={`archive-command-metric ${tone ?? ""}`.trim()}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{meta}</p>
    </div>
  );
}
