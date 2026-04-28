// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-003-engineering-standards.md

import { startTransition, useDeferredValue, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type {
  AddOnManifest,
  ArchiveDocumentPayload,
  ArchiveImportedLibrarySummary,
  ArchiveLibraryClassificationReview,
  ArchiveLibraryReorganisationPlan,
  ArchivePromoteReviewArtifactResult,
  ArchiveProcessIngestResult,
  ArchiveQueuedIngestRequest,
  ArchiveReviewArtifact,
  ArchiveReviewDecisionResult,
  ArchiveLibraryImportResult,
  ArchiveLibraryImportMode,
  ArchiveLibraryPreflightResult,
  ArchiveMemoryDomain,
  ArchiveSourceFolderScanResult,
  ArchiveSourceWatchRecord,
  ArchiveTolBundleBuildResult,
  ArchiveTolBundleCandidate,
  ArchiveIngestProbeResult,
  ArchiveRuntimeStatus,
  ArchiveSearchResult,
  ChatRunPhase,
  ConversationThread,
  LocalRuntimeStatus,
  ProviderDiagnosticReport,
  ProviderSmokeTestResult,
  RecoveryRouteCandidate,
  ResonantShellState,
} from "./core/contracts";
import { routedProviderLabel } from "./core/provider-service";
import {
  createDesktopBrowserToolRunner,
  persistState,
  requestBrowserNativeWebviewHide,
  requestBrowserNativeWebviewResize,
  requestBrowserNativeWebviewShow,
  requestObsidianVaultFolderSelection,
} from "./core/runtime";
import {
  executeSideloadManifest,
  grantAddonCapabilities,
  toggleAddonCapabilityGrant,
  toggleAddonInstallation,
  updateAddonConfig,
} from "./modules/addons/controller";
import {
  executeArchiveIngestProbe,
  executeArchiveSearch,
  buildArchiveTolBundle,
  decideArchiveReviewArtifact,
  generateArchiveLibraryReorganisationPlan,
  importArchiveLibrary,
  loadArchiveLibraryClassificationReview,
  loadArchiveImportedLibraries,
  loadArchiveTolBundles,
  loadArchiveDocument,
  loadArchiveReviewQueue,
  loadArchiveRuntimeStatus,
  pickArchiveLibraryFolder,
  preflightArchiveLibrary,
  processArchiveQueuedRequest,
  promoteArchiveReviewArtifact,
  queueArchiveSourceForIngest,
  queueWatchedArchiveSourceForIngest,
  scanArchiveSourceFolders,
} from "./modules/archive/controller";
import { buildArchivePreflightAugmentorPrompt } from "./modules/archive/archive-augmentor-handoff";
import {
  attachComposerFiles,
  BrowserSpeechRecognition,
  removeComposerAttachment,
  toggleComposerDictation,
} from "./modules/chat/composer-controller";
import { saveChatMessageToArchiveIntake } from "./modules/chat/archive-intake-controller";
import { executeChatTurn } from "./modules/chat/controller";
import { StrategistChatRail } from "./modules/chat/StrategistChatRail";
import { appendTranscriptEvent } from "./core/context-memory";
import {
  branchChatFromMessageAction,
  branchChatProjectAction,
  branchChatThreadAction,
  createAgentChatThreadAction,
  createChatProjectAction,
  deleteChatProjectAction,
  compactActiveChatContextAction,
  deleteChatMessageAction,
  deleteChatThreadAction,
  editUserMessageAction,
  moveChatThreadToProjectAction,
  renameChatProjectAction,
  renameChatThreadAction,
  selectChatAgentAction,
  stopChatGenerationAction,
  togglePinnedChatProjectAction,
  togglePinnedChatThreadAction,
  updateCompactMemoryAction,
} from "./modules/chat/thread-controller";
import type { ComposerAttachment, ThinkingDepth } from "./modules/chat/types";
import { Panel } from "./components/Panel";
import { ArchiveWorkspace } from "./modules/archive/ArchiveWorkspace";
import { AddOnsWorkspace } from "./modules/addons/AddOnsWorkspace";
import { BrowserWorkspace } from "./modules/browser/BrowserWorkspace";
import { ObsidianWorkspace } from "./modules/obsidian/ObsidianWorkspace";
import { OpenCodeWorkspace } from "./modules/opencode/OpenCodeWorkspace";
import { TerminalWorkspace } from "./modules/terminal/TerminalWorkspace";
import { DelegationWorkspace } from "./modules/delegation/DelegationWorkspace";
import { OverviewWorkspace } from "./modules/overview/OverviewWorkspace";
import { promoteRecoveryRoute, RECOVERY_RUNBOOK_PROMPT, setRecoveryMode } from "./modules/recovery/controller";
import { RecoveryWorkspace } from "./modules/recovery/RecoveryWorkspace";
import { loadInitialShellState, loadRecoveryRuntimeSnapshot } from "./modules/shell/controller";
import { buildShellViewModel, resolveActiveProviderForSelection } from "./modules/shell/selectors";
import {
  executeRefreshProviderDiagnostics,
  executeProviderSmokeTest,
  executeSaveProviderSecret,
  updateProviderProfile,
} from "./modules/settings/controller";
import { SettingsWorkspace, type SettingsSection } from "./modules/settings/SettingsWorkspace";
import {
  activateChatThread,
  renameStrategistIdentity,
  toggleStrategistChannel,
} from "./modules/strategist/controller";
import { StrategistWorkspace } from "./modules/strategist/StrategistWorkspace";

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; state: ResonantShellState; bundled: AddOnManifest[]; sideloaded: AddOnManifest[] }
  | { phase: "error"; message: string };

type Section = ResonantShellState["uiPreferences"]["activeSection"];
type DockIconId =
  | "home"
  | "archive"
  | "delegation"
  | "addons"
  | "browser"
  | "opencode"
  | "terminal"
  | "agent"
  | "settings";
type VendorIconId =
  | "apps"
  | "archive"
  | "database"
  | "home"
  | "layout-sidebar-left-expand"
  | "layout-sidebar-right-collapse"
  | "robot"
  | "route-alt-left"
  | "settings"
  | "world";

const dockIconMap: Record<DockIconId, VendorIconId> = {
  home: "home",
  archive: "database",
  delegation: "route-alt-left",
  addons: "apps",
  browser: "world",
  opencode: "settings",
  terminal: "settings",
  agent: "robot",
  settings: "settings",
};

const navItems: Array<{ id: Section; label: string; eyebrow: string; icon: DockIconId; pinned?: boolean }> = [
  { id: "overview", label: "Home", eyebrow: "apps", icon: "home", pinned: true },
  { id: "archive", label: "Living Archive", eyebrow: "memory", icon: "archive", pinned: true },
  { id: "delegation", label: "Delegation", eyebrow: "tasks", icon: "delegation", pinned: true },
  { id: "addons", label: "Add-ons", eyebrow: "catalog", icon: "addons", pinned: true },
  { id: "strategist", label: "Agent Identity", eyebrow: "identity", icon: "agent" },
  { id: "settings", label: "Settings", eyebrow: "system", icon: "settings", pinned: true },
];

const CHAT_HISTORY_WIDTH = 300;
const CHAT_RAIL_MIN_WIDTH = 420;
const CHAT_RAIL_MAX_WIDTH = 1240;
const CHAT_RAIL_WITH_HISTORY_MIN_WIDTH = 760;
const ZOOM_STEP = 0.05;
const MIN_WINDOW_ZOOM = 0.85;
const MAX_WINDOW_ZOOM = 1.25;

const clampChatWidth = (width: number): number => Math.min(CHAT_RAIL_MAX_WIDTH, Math.max(CHAT_RAIL_MIN_WIDTH, Math.round(width)));
const clampWindowZoom = (zoom: number): number => Math.min(MAX_WINDOW_ZOOM, Math.max(MIN_WINDOW_ZOOM, Number(zoom.toFixed(2))));

const errorMessageOf = (error: unknown, fallback: string): string =>
  typeof error === "string" ? error : error instanceof Error ? error.message : fallback;

export function App() {
  const [loadState, setLoadState] = useState<LoadState>({ phase: "loading" });
  const currentReadyStateRef = useRef<ResonantShellState | null>(null);
  const [search, setSearch] = useState("");
  const [sideloadPath, setSideloadPath] = useState("");
  const [selectedAddonId, setSelectedAddonId] = useState<string>("");
  const [archiveFocusTarget, setArchiveFocusTarget] = useState<"review" | null>(null);
  const [composer, setComposer] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatRunPhase, setChatRunPhase] = useState<ChatRunPhase>("idle");
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const [providerDrafts, setProviderDrafts] = useState<Record<string, string>>({});
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("providers");
  const [providerDiagnostics, setProviderDiagnostics] = useState<ProviderDiagnosticReport[]>([]);
  const [providerDiagnosticsBusy, setProviderDiagnosticsBusy] = useState(false);
  const [activeProviderProbeId, setActiveProviderProbeId] = useState<string | null>(null);
  const [providerSmokeResults, setProviderSmokeResults] = useState<Record<string, ProviderSmokeTestResult>>({});
  const [providerSmokeBusyId, setProviderSmokeBusyId] = useState<string | null>(null);
  const [thinkingDepth, setThinkingDepth] = useState<ThinkingDepth>("high");
  const [selectedChatModel, setSelectedChatModel] = useState<string>("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [dictating, setDictating] = useState(false);
  const [agentActivityLabel, setAgentActivityLabel] = useState("Standing by.");
  const [systemClockLabel, setSystemClockLabel] = useState(() =>
    new Date().toLocaleString([], {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
    }),
  );
  const [recoveryRuntimeStatus, setRecoveryRuntimeStatus] = useState<LocalRuntimeStatus | null>(null);
  const [recoveryCandidates, setRecoveryCandidates] = useState<RecoveryRouteCandidate[]>([]);
  const [archiveStatusBusy, setArchiveStatusBusy] = useState(false);
  const [archiveStatus, setArchiveStatus] = useState<ArchiveRuntimeStatus | null>(null);
  const [archiveSearchBusy, setArchiveSearchBusy] = useState(false);
  const [archiveSearchResult, setArchiveSearchResult] = useState<ArchiveSearchResult | null>(null);
  const [archiveDocumentBusy, setArchiveDocumentBusy] = useState(false);
  const [archiveDocument, setArchiveDocument] = useState<ArchiveDocumentPayload | null>(null);
  const [archiveQueueBusy, setArchiveQueueBusy] = useState(false);
  const [archiveQueue, setArchiveQueue] = useState<ArchiveQueuedIngestRequest[]>([]);
  const [archiveReviewArtifacts, setArchiveReviewArtifacts] = useState<ArchiveReviewArtifact[]>([]);
  const [archiveProcessResult, setArchiveProcessResult] = useState<ArchiveProcessIngestResult | null>(null);
  const [archiveReviewDecisionResult, setArchiveReviewDecisionResult] = useState<ArchiveReviewDecisionResult | null>(null);
  const [archivePromotionResult, setArchivePromotionResult] = useState<ArchivePromoteReviewArtifactResult | null>(null);
  const [archiveTolBundles, setArchiveTolBundles] = useState<ArchiveTolBundleCandidate[]>([]);
  const [archiveTolBundleResult, setArchiveTolBundleResult] = useState<ArchiveTolBundleBuildResult | null>(null);
  const [archiveSourceScanBusy, setArchiveSourceScanBusy] = useState(false);
  const [archiveSourceScanResult, setArchiveSourceScanResult] = useState<ArchiveSourceFolderScanResult | null>(null);
  const [archiveImportedLibraries, setArchiveImportedLibraries] = useState<ArchiveImportedLibrarySummary[]>([]);
  const [archiveClassificationReview, setArchiveClassificationReview] = useState<ArchiveLibraryClassificationReview | null>(null);
  const [archiveReorganisationPlan, setArchiveReorganisationPlan] = useState<ArchiveLibraryReorganisationPlan | null>(null);
  const [archiveLibraryImportResult, setArchiveLibraryImportResult] = useState<ArchiveLibraryImportResult | null>(null);
  const [archiveLibraryPreflightResult, setArchiveLibraryPreflightResult] = useState<ArchiveLibraryPreflightResult | null>(null);
  const [archiveProbeBusy, setArchiveProbeBusy] = useState(false);
  const [archiveProbeResult, setArchiveProbeResult] = useState<{
    probe: ArchiveIngestProbeResult;
    routeLabel: string;
    model: string;
    resolutionReason: string;
  } | null>(null);
  const chatScrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const activeChatRunTokenRef = useRef<string | null>(null);
  const deferredSearch = useDeferredValue(search);
  const activeProviderForSelection = resolveActiveProviderForSelection(
    loadState.phase === "ready" ? loadState.state : null,
    selectedChatModel,
    loadState.phase === "ready" ? loadState.state.uiPreferences.activeChatThreadId : undefined,
  );

  useEffect(() => {
    void (async () => {
      try {
        const booted = await loadInitialShellState();
        setLoadState({
          phase: "ready",
          state: booted.state,
          bundled: booted.bundled,
          sideloaded: booted.sideloaded,
        });
        setSelectedAddonId(booted.selectedAddonId);
      } catch (error) {
        setLoadState({
          phase: "error",
          message: errorMessageOf(error, "Failed to boot ResonantOS vNext."),
        });
      }
    })();
  }, []);

  useEffect(() => {
    if (loadState.phase !== "ready" || !loadState.state.uiPreferences.chatSidebarOpen) {
      return;
    }
    const activeAgentId = loadState.state.recoverySession.active ? loadState.state.recoverySession.engineerAgentId : "strategist.core";
    const visibleThreads = loadState.state.conversationThreads.filter((thread) => thread.owningAgentId === activeAgentId);
    const activeThread =
      visibleThreads.find((thread) => thread.id === loadState.state.uiPreferences.activeChatThreadId) ?? visibleThreads[0] ?? null;
    if (!activeThread) {
      return;
    }
    chatScrollAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [loadState]);

  useEffect(() => {
    if (!activeProviderForSelection) {
      return;
    }
    if (!selectedChatModel || !activeProviderForSelection.allowedModels.includes(selectedChatModel)) {
      setSelectedChatModel(activeProviderForSelection.primaryModel);
    }
  }, [activeProviderForSelection, selectedChatModel]);

  useEffect(() => {
    if (loadState.phase !== "ready" || !loadState.state.recoverySession.active) {
      setRecoveryRuntimeStatus(null);
      setRecoveryCandidates([]);
      return;
    }

    void (async () => {
      try {
        const snapshot = await loadRecoveryRuntimeSnapshot(loadState.state);
        setRecoveryRuntimeStatus(snapshot.status);
        setRecoveryCandidates(snapshot.candidates);
      } catch {
        setRecoveryRuntimeStatus(null);
        setRecoveryCandidates([]);
      }
    })();
  }, [loadState]);

  useEffect(() => {
    if (loadState.phase !== "ready" || settingsSection !== "providers" || providerDiagnostics.length) {
      return;
    }
    void refreshProviderDiagnostics();
  }, [loadState, settingsSection, providerDiagnostics.length]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setSystemClockLabel(
        new Date().toLocaleString([], {
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
          day: "2-digit",
          month: "short",
        }),
      );
    }, 60_000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }

      const key = event.key;
      const direction = key === "+" || key === "=" ? 1 : key === "-" || key === "_" ? -1 : key === "0" ? 0 : null;
      if (direction === null) {
        return;
      }

      event.preventDefault();
      setLoadState((current) => {
        if (current.phase !== "ready") {
          return current;
        }
        const currentZoom = current.state.uiPreferences.windowZoom ?? 1;
        const nextZoom = direction === 0 ? 1 : clampWindowZoom(currentZoom + direction * ZOOM_STEP);
        const nextState = {
          ...current.state,
          uiPreferences: {
            ...current.state.uiPreferences,
            windowZoom: nextZoom,
          },
        };
        void persistState(nextState);
        return {
          ...current,
          state: nextState,
        };
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (loadState.phase !== "ready") {
      return;
    }
    if (loadState.state.uiPreferences.activeSection !== "archive" || loadState.state.recoverySession.active) {
      return;
    }
    if (archiveStatusBusy || archiveStatus) {
      return;
    }
    void refreshArchiveRuntime();
  }, [loadState, archiveStatusBusy, archiveStatus]);

  useEffect(() => {
    if (loadState.phase !== "ready") {
      return;
    }
    if (loadState.state.uiPreferences.activeSection !== "archive" || loadState.state.recoverySession.active) {
      return;
    }
    if (archiveQueueBusy || archiveQueue.length) {
      return;
    }
    void refreshArchiveQueue();
  }, [loadState, archiveQueueBusy, archiveQueue.length]);

  if (loadState.phase === "loading") {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <p className="eyebrow">ResonantOS vNext</p>
          <h1>Booting the new shell.</h1>
          <p>
            Loading the core runtime, Living Archive policy, provider vault, and bundled add-on manifests.
          </p>
        </div>
      </div>
    );
  }

  if (loadState.phase === "error") {
    return (
      <div className="boot-screen">
        <div className="boot-card error">
          <p className="eyebrow">Boot failed</p>
          <h1>ResonantOS did not initialize.</h1>
          <p>{loadState.message}</p>
        </div>
      </div>
    );
  }

  const { state, bundled, sideloaded } = loadState;
  currentReadyStateRef.current = state;
  const cloneState = (current: ResonantShellState): ResonantShellState =>
    JSON.parse(JSON.stringify(current)) as ResonantShellState;
  const commitReadyState = (nextState: ResonantShellState, nextSideloaded = sideloaded) => {
    currentReadyStateRef.current = nextState;
    setLoadState({ phase: "ready", state: nextState, bundled, sideloaded: nextSideloaded });
    void persistState(nextState);
  };
  const updateRuntimeState = (updater: (current: ResonantShellState) => ResonantShellState) => {
    const nextState = updater(cloneState(currentReadyStateRef.current ?? state));
    commitReadyState(nextState);
  };
  const {
    allManifests,
    filteredManifests,
    currentSection,
    displayedStrategistName,
    selectedManifest,
    selectedInstallation,
    recoveryModeActive,
    visibleThreads,
    activeThread,
    strategist,
    engineerAgent,
    strategistRoute,
    activeRoute,
    activeProvider,
    activeRuntimeNode,
    activeChatModel,
    strategistRecoveryActive,
    contextBudget,
    contextUsageRatio,
    contextUsageLabel,
    contextUsageTitle,
    latestCompactState,
    dictationAvailable,
  } = buildShellViewModel({
    state,
    bundled,
    sideloaded,
    deferredSearch,
    selectedAddonId,
    composer,
    attachments,
    selectedChatModel,
  });

  const setSection = (section: Section) => {
    startTransition(() => {
      if (section !== "archive") {
        setArchiveFocusTarget(null);
      }
      updateRuntimeState((draft) => {
        draft.uiPreferences.activeSection = section;
        return draft;
      });
    });
  };

  const openArchiveReview = () => {
    setArchiveFocusTarget("review");
    setSection("archive");
  };

  const toggleChatSidebar = () => {
    updateRuntimeState((draft) => {
      draft.uiPreferences.chatSidebarOpen = !draft.uiPreferences.chatSidebarOpen;
      return draft;
    });
  };

  const toggleWorkspaceLayout = () => {
    updateRuntimeState((draft) => {
      draft.uiPreferences.workspaceLayout = draft.uiPreferences.workspaceLayout === "chat-main" ? "main-chat" : "chat-main";
      draft.uiPreferences.chatSidebarOpen = true;
      return draft;
    });
  };

  const setChatHistoryOpen = (open: boolean) => {
    updateRuntimeState((draft) => {
      const currentWidth = clampChatWidth(draft.uiPreferences.chatSidebarWidth);
      draft.uiPreferences.chatHistoryOpen = open;
      draft.uiPreferences.chatSidebarOpen = true;
      draft.uiPreferences.chatSidebarWidth = open
        ? Math.max(CHAT_RAIL_WITH_HISTORY_MIN_WIDTH, clampChatWidth(currentWidth + CHAT_HISTORY_WIDTH))
        : clampChatWidth(currentWidth - CHAT_HISTORY_WIDTH);
      return draft;
    });
  };

  const startChatRailResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (loadState.phase !== "ready") {
      return;
    }

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = loadState.state.uiPreferences.chatSidebarWidth;
    const resizeDirection = loadState.state.uiPreferences.workspaceLayout === "chat-main" ? 1 : -1;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampChatWidth(startWidth + (moveEvent.clientX - startX) * resizeDirection);
      setLoadState((current) => {
        if (current.phase !== "ready") {
          return current;
        }

        return {
          ...current,
          state: {
            ...current.state,
            uiPreferences: {
              ...current.state.uiPreferences,
              chatSidebarWidth: nextWidth,
            },
          },
        };
      });
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);

      setLoadState((current) => {
        if (current.phase !== "ready") {
          return current;
        }

        void persistState(current.state);
        return current;
      });
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const handleSaveProviderSecret = async (profileId: string) => {
    await executeSaveProviderSecret({
      snapshot: { state, bundled, sideloaded },
      profileId,
      secret: providerDrafts[profileId] ?? "",
      commitReadyState,
      updateRuntimeState,
      setProviderDrafts,
      setSettingsNotice,
      setProviderDiagnosticsBusy,
      setActiveProviderProbeId,
      setProviderDiagnostics,
      errorMessageOf,
    });
  };

  const refreshProviderDiagnostics = async (providerId?: string) => {
    await executeRefreshProviderDiagnostics({
      snapshot: { state, bundled, sideloaded },
      providerId,
      commitReadyState,
      updateRuntimeState,
      setProviderDiagnosticsBusy,
      setActiveProviderProbeId,
      setProviderDiagnostics,
      setSettingsNotice,
      errorMessageOf,
    });
  };

  const runProviderSmokeTest = async (providerId: string) => {
    await executeProviderSmokeTest({
      snapshot: { state, bundled, sideloaded },
      providerId,
      setProviderSmokeBusyId,
      setProviderSmokeResults,
      setSettingsNotice,
      errorMessageOf,
    });
  };

  const refreshArchiveRuntime = async () => {
    await loadArchiveRuntimeStatus({
      setChatNotice,
      setArchiveStatusBusy,
      setArchiveStatus,
      errorMessageOf,
    });
    await loadArchiveImportedLibraries({
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveImportedLibraries,
      errorMessageOf,
    });
  };

  const refreshArchiveSourceRegistry = async () => {
    await loadArchiveImportedLibraries({
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveImportedLibraries,
      errorMessageOf,
    });
  };

  const refreshArchiveQueue = async () => {
    await loadArchiveReviewQueue({
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveQueue,
      setArchiveReviewArtifacts,
      errorMessageOf,
    });
  };

  const runArchiveSearch = async (query: string) => {
    await executeArchiveSearch({
      query,
      setChatNotice,
      setArchiveSearchBusy,
      setArchiveSearchResult,
      errorMessageOf,
    });
  };

  const queueArchiveSource = async (source: ArchiveSearchResult["sources"][number]) => {
    await queueArchiveSourceForIngest({
      source,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveQueue,
      setArchiveReviewArtifacts,
      errorMessageOf,
    });
  };

  const queueWatchedArchiveSource = async (source: ArchiveSourceWatchRecord) => {
    await queueWatchedArchiveSourceForIngest({
      source,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveQueue,
      setArchiveReviewArtifacts,
      errorMessageOf,
    });
  };

  const runArchiveSourceFolderScan = async (rootPath?: string) => {
    await scanArchiveSourceFolders({
      rootPath,
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveSourceScanResult,
      errorMessageOf,
    });
  };

  const runArchiveLibraryImport = async (input: {
    sourcePath: string;
    domain: ArchiveMemoryDomain;
    importMode: ArchiveLibraryImportMode;
    libraryName?: string;
    excludedTopFolders?: string[];
  }) => {
    await importArchiveLibrary({
      ...input,
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveLibraryImportResult,
      setArchiveImportedLibraries,
      errorMessageOf,
    });
  };

  const runArchiveLibraryPreflight = async (sourcePath: string) => {
    await preflightArchiveLibrary({
      sourcePath,
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveLibraryPreflightResult,
      errorMessageOf,
    });
  };

  const openArchiveClassificationReview = async (classificationManifestPath: string) => {
    await loadArchiveLibraryClassificationReview({
      classificationManifestPath,
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveClassificationReview,
      errorMessageOf,
    });
    setArchiveReorganisationPlan(null);
  };

  const runArchiveReorganisationPlan = async (classificationManifestPath: string) => {
    await generateArchiveLibraryReorganisationPlan({
      classificationManifestPath,
      setChatNotice,
      setArchiveSourceScanBusy,
      setArchiveReorganisationPlan,
      errorMessageOf,
    });
  };

  const runPickArchiveLibraryFolder = async (): Promise<string | null> =>
    pickArchiveLibraryFolder({
      setChatNotice,
      errorMessageOf,
    });

  const runArchiveQueuedRequest = async (requestFile: string) => {
    await processArchiveQueuedRequest({
      snapshot: { state, bundled, sideloaded },
      requestFile,
      commitReadyState,
      setProviderDiagnostics,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveQueue,
      setArchiveProcessResult,
      setArchiveReviewArtifacts,
      errorMessageOf,
    });
  };

  const runArchiveReviewDecision = async (
    artifactFile: string,
    action: "approve" | "reject" | "escalate",
    actorId: string,
  ) => {
    await decideArchiveReviewArtifact({
      artifactFile,
      action,
      actorId,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveReviewArtifacts,
      setArchiveReviewDecisionResult,
      errorMessageOf,
    });
  };

  const runArchivePromotion = async (artifactFile: string) => {
    await promoteArchiveReviewArtifact({
      artifactFile,
      actorId: "archive-ingest.core",
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveReviewArtifacts,
      setArchivePromotionResult,
      errorMessageOf,
    });
  };

  const refreshArchiveTolBundles = async () => {
    await loadArchiveTolBundles({
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveTolBundles,
      errorMessageOf,
    });
  };

  const runArchiveTolBundleBuild = async (sessionId: string) => {
    await buildArchiveTolBundle({
      sessionId,
      setChatNotice,
      setArchiveQueueBusy,
      setArchiveTolBundles,
      setArchiveQueue,
      setArchiveReviewArtifacts,
      setArchiveTolBundleResult,
      errorMessageOf,
    });
  };

  const openArchiveDocument = async (path: string) => {
    await loadArchiveDocument({
      path,
      setChatNotice,
      setArchiveDocumentBusy,
      setArchiveDocument,
      errorMessageOf,
    });
  };

  const handleSideload = async () => {
    await executeSideloadManifest({
      sideloadPath,
      bundled,
      sideloaded,
      setReadyState: (nextState, nextSideloaded) => commitReadyState(nextState, nextSideloaded),
      setSelectedAddonId,
      setSideloadPath,
      setErrorState: (message) => setLoadState({ phase: "error", message }),
      errorMessageOf,
    });
  };

  const sendStrategistMessage = async (overrideMessage?: string) => {
    if (!activeThread || !(overrideMessage ?? composer).trim()) {
      return;
    }
    if (chatBusy) {
      setChatNotice("Stop the current response before sending a follow-up correction.");
      return;
    }
    const runToken = `chat-run-${activeThread.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${Date.now()}`;
    activeChatRunTokenRef.current = runToken;
    await executeChatTurn({
      snapshot: { state, bundled, sideloaded },
      activeThread,
      composer,
      attachments,
      activeChatModel,
      thinkingDepth,
      overrideMessage,
      commitReadyState,
      setComposer,
      setAttachments,
      setChatNotice,
      setChatBusy,
      setChatRunPhase,
      setAgentActivityLabel,
      setProviderDiagnostics,
      setRecoveryRuntimeStatus,
      runToken,
      isRunCurrent: (token) => activeChatRunTokenRef.current === token,
      errorMessageOf,
    });
    if (activeChatRunTokenRef.current === runToken) {
      activeChatRunTokenRef.current = null;
      setChatRunPhase("idle");
    }
  };

  const startArchivePreflightAugmentorSession = async (report: ArchiveLibraryPreflightResult) => {
    if (chatBusy) {
      setChatNotice("Stop the current response before opening a Living Archive plan discussion.");
      return;
    }
    const channel =
      state.channels.find((item) => item.id === "desktop-main" && item.enabled) ??
      state.channels.find((item) => item.owningAgentId === "strategist.core" && item.enabled) ??
      null;
    if (!channel) {
      setChatNotice("No enabled Augmentor desktop channel is available for this discussion.");
      return;
    }

    const threadId = `thread-archive-preflight-${Date.now()}`;
    const thread: ConversationThread = {
      id: threadId,
      title: "Living Archive import plan",
      owningAgentId: "strategist.core",
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      summary: "Augmentor discussion about a Living Archive import preflight and recommended plan.",
      messages: [],
    };
    const nextState = appendTranscriptEvent(
      {
        ...cloneState(state),
        conversationThreads: [thread, ...state.conversationThreads],
        uiPreferences: {
          ...state.uiPreferences,
          activeChatThreadId: threadId,
          chatSidebarOpen: true,
          chatHistoryOpen: false,
        },
      },
      {
        action: "thread-created",
        threadId,
        channelId: channel.id,
        agentId: "strategist.core",
        payload: {
          title: thread.title,
          workspaceId: channel.workspaceId,
          source: "living-archive-preflight",
        },
      },
    );
    commitReadyState(nextState);

    const runToken = `chat-run-${threadId}-${Date.now()}`;
    activeChatRunTokenRef.current = runToken;
    await executeChatTurn({
      snapshot: { state: nextState, bundled, sideloaded },
      activeThread: thread,
      composer: "",
      attachments: [],
      activeChatModel,
      thinkingDepth,
      overrideMessage: buildArchivePreflightAugmentorPrompt(report),
      commitReadyState,
      setComposer,
      setAttachments,
      setChatNotice,
      setChatBusy,
      setChatRunPhase,
      setAgentActivityLabel,
      setProviderDiagnostics,
      setRecoveryRuntimeStatus,
      runToken,
      isRunCurrent: (token) => activeChatRunTokenRef.current === token,
      errorMessageOf,
    });
    if (activeChatRunTokenRef.current === runToken) {
      activeChatRunTokenRef.current = null;
      setChatRunPhase("idle");
    }
  };

  const startRecoveryRunbook = () => {
    if (!recoveryModeActive || chatBusy) {
      return;
    }
    void sendStrategistMessage(RECOVERY_RUNBOOK_PROMPT);
  };

  const runArchiveIngestProbe = async () => {
    if (archiveProbeBusy || recoveryModeActive) {
      return;
    }

    await executeArchiveIngestProbe({
      snapshot: { state, bundled, sideloaded },
      commitReadyState,
      setProviderDiagnostics,
      setChatNotice,
      setArchiveProbeBusy,
      setArchiveProbeResult,
      errorMessageOf,
    });
  };

  const shellStyle = {
    "--chat-rail-width": `${clampChatWidth(state.uiPreferences.chatSidebarWidth)}px`,
    "--chat-history-width": `${CHAT_HISTORY_WIDTH}px`,
  } as CSSProperties;
  const zoomStyle = {
    "--app-zoom": `${state.uiPreferences.windowZoom ?? 1}`,
  } as CSSProperties;
  const activeChatAgent = activeThread ? state.agents.find((agent) => agent.id === activeThread.owningAgentId) : null;
  const activeChatAgentName =
    activeChatAgent?.id === "strategist.core" ? displayedStrategistName : activeChatAgent?.displayName ?? displayedStrategistName;
  const browserManifest = allManifests.find((manifest) => manifest.id === "addon.browser");
  const browserInstallation = state.installations["addon.browser"];
  const obsidianManifest = allManifests.find((manifest) => manifest.id === "addon.obsidian");
  const obsidianInstallation = state.installations["addon.obsidian"];
  const opencodeManifest = allManifests.find((manifest) => manifest.id === "addon.opencode");
  const opencodeInstallation = state.installations["addon.opencode"];
  const terminalManifest = allManifests.find((manifest) => manifest.id === "addon.terminal");
  const terminalInstallation = state.installations["addon.terminal"];
  const grantBrowserVisibleAccess = () => {
    if (!browserManifest) {
      return;
    }
    updateRuntimeState((draft) => {
      const installation = draft.installations[browserManifest.id];
      if (!installation) {
        return draft;
      }
      installation.installed = true;
      installation.enabled = true;
      const existingGrants = new Map(installation.grantedCapabilities.map((grant) => [grant.capability, grant]));
      const missingRequestedGrants = browserManifest.requestedCapabilities.filter((grant) => !existingGrants.has(grant.capability));
      installation.grantedCapabilities = [...installation.grantedCapabilities, ...missingRequestedGrants].map((grant) =>
        ["network", "ui-embedding", "browser-control"].includes(grant.capability) ? { ...grant, granted: true } : grant,
      );
      installation.status = "enabled";
      installation.notes = ["Installed, enabled, and granted network, ui-embedding, browser-control through Browser setup."];
      draft.uiPreferences.activeSection = "browser";
      return draft;
    });
  };
  const updateBrowserWorkspaceState = (browserWorkspace: ResonantShellState["uiPreferences"]["browserWorkspace"]) => {
    updateRuntimeState((draft) => {
      draft.uiPreferences.browserWorkspace = browserWorkspace;
      return draft;
    });
  };
  const patchControlledBrowserSession = (
    controlledSession: Partial<ResonantShellState["uiPreferences"]["browserWorkspace"]["controlledSession"]>,
  ) => {
    updateRuntimeState((draft) => {
      draft.uiPreferences.browserWorkspace.controlledSession = {
        ...draft.uiPreferences.browserWorkspace.controlledSession,
        ...controlledSession,
      };
      return draft;
    });
  };
  const syncControlledBrowserSession = async (url: string): Promise<string> => {
    const runner = createDesktopBrowserToolRunner({
      manifest: browserManifest,
      installation: browserInstallation,
    });
    patchControlledBrowserSession({
      status: "starting",
      url,
      error: null,
      lastSyncedAt: new Date().toISOString(),
    });

    try {
      const health = await runner.run({ type: "health" });
      const hasLiveSession = "ready" in health && health.ready;
      const result = hasLiveSession
        ? await runner.run({ type: "open_url", params: { url } })
        : await runner.run({ type: "start", params: { defaultUrl: url, headless: false } });
      const sessionId = "sessionId" in result ? result.sessionId : null;
      const finalUrl = "finalUrl" in result ? result.finalUrl : "url" in result ? result.url : url;
      const title = "title" in result ? result.title : null;
      patchControlledBrowserSession({
        sessionId,
        status: "ready",
        url: finalUrl,
        title,
        error: null,
        lastSyncedAt: new Date().toISOString(),
      });
      return `Controlled Chromium synced: ${title || finalUrl || "active session"}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Controlled Browser session sync failed.";
      patchControlledBrowserSession({
        status: "error",
        error: message,
        lastSyncedAt: new Date().toISOString(),
      });
      throw new Error(message);
    }
  };
  const showNativeBrowserWebview = async (input: {
    url: string;
    bounds: { x: number; y: number; width: number; height: number };
    navigate: boolean;
  }): Promise<string> => {
    const result = await requestBrowserNativeWebviewShow(input);
    patchControlledBrowserSession({
      status: "ready",
      url: result.url ?? state.uiPreferences.browserWorkspace.controlledSession.url ?? input.url,
      title: "Native Browser",
      error: null,
      lastSyncedAt: new Date().toISOString(),
    });
    return result.status === "shown" ? "Native Browser restored." : "Native Browser loaded.";
  };
  const resizeNativeBrowserWebview = async (bounds: { x: number; y: number; width: number; height: number }): Promise<void> => {
    await requestBrowserNativeWebviewResize(bounds);
  };
  const hideNativeBrowserWebview = async (): Promise<void> => {
    await requestBrowserNativeWebviewHide();
  };
  const readActiveBrowserPage = async (url: string): Promise<string> => {
    const runner = createDesktopBrowserToolRunner({
      manifest: browserManifest,
      installation: browserInstallation,
    });
    const health = await runner.run({ type: "health" });
    if (!("ready" in health) || !health.ready) {
      await runner.run({ type: "start", params: { defaultUrl: url, headless: false } });
    } else if (health.url !== url) {
      await runner.run({ type: "open_url", params: { url } });
    }
    const result = await runner.run({ type: "read_page" });
    if (!("text" in result)) {
      return "Browser host responded, but did not return readable page text.";
    }
    patchControlledBrowserSession({
      sessionId: result.sessionId,
      status: "ready",
      url: result.finalUrl,
      title: result.title,
      error: null,
      lastSyncedAt: new Date().toISOString(),
    });
    const summary = `Controlled read: ${result.title || "Untitled"} · ${result.text.length} text characters · ${result.links.length} links`;
    setChatNotice(summary);
    return summary;
  };
  const grantObsidianWorkspaceAccess = async () => {
    if (!obsidianManifest) {
      return;
    }
    const currentVaultPath =
      typeof obsidianInstallation?.config?.vaultPath === "string" ? obsidianInstallation.config.vaultPath : "";
    const selectedVaultPath = currentVaultPath || (await requestObsidianVaultFolderSelection());
    updateRuntimeState((draft) => {
      const installation = draft.installations[obsidianManifest.id];
      if (!installation) {
        return draft;
      }
      installation.installed = true;
      installation.enabled = true;
      installation.status = "enabled";
      const existingGrants = new Map(installation.grantedCapabilities.map((grant) => [grant.capability, grant]));
      const missingRequestedGrants = obsidianManifest.requestedCapabilities.filter((grant) => !existingGrants.has(grant.capability));
      installation.grantedCapabilities = [...installation.grantedCapabilities, ...missingRequestedGrants].map((grant) =>
        grant.capability === "filesystem" || grant.capability === "ui-embedding" ? { ...grant, granted: true } : grant,
      );
      if (selectedVaultPath) {
        installation.config = {
          ...(installation.config ?? {}),
          vaultPath: selectedVaultPath,
          lastWorkspaceConnectedAt: new Date().toISOString(),
        };
      }
      installation.notes = selectedVaultPath
        ? [`Workspace access granted for ${selectedVaultPath}.`]
        : ["Workspace access granted. Choose a vault to open the Obsidian workspace."];
      return draft;
    });
  };
  const grantOpenCodeWorkspaceAccess = () => {
    if (!opencodeManifest) {
      return;
    }
    updateRuntimeState((draft) => {
      const installation = draft.installations[opencodeManifest.id];
      if (!installation) {
        return draft;
      }
      installation.installed = true;
      installation.enabled = true;
      installation.status = "enabled";
      const existingGrants = new Map(installation.grantedCapabilities.map((grant) => [grant.capability, grant]));
      const missingRequestedGrants = opencodeManifest.requestedCapabilities.filter((grant) => !existingGrants.has(grant.capability));
      installation.grantedCapabilities = [...installation.grantedCapabilities, ...missingRequestedGrants].map((grant) =>
        ["filesystem", "shell", "ui-embedding"].includes(grant.capability) ? { ...grant, granted: true } : grant,
      );
      installation.notes = ["Installed, enabled, and granted scoped filesystem, shell, and UI embedding for OpenCode workspace spike."];
      draft.uiPreferences.activeSection = "opencode";
      return draft;
    });
  };
  const updateOpenCodeWorkspacePath = (workspacePath: string) => {
    if (!opencodeManifest) {
      return;
    }
    updateRuntimeState((draft) => {
      const installation = draft.installations[opencodeManifest.id];
      if (!installation) {
        return draft;
      }
      installation.config = {
        ...(installation.config ?? {}),
        workspacePath,
        lastWorkspaceSelectedAt: new Date().toISOString(),
      };
      return draft;
    });
  };
  const grantTerminalWorkspaceAccess = () => {
    if (!terminalManifest) {
      return;
    }
    grantAddonCapabilities(
      terminalManifest.id,
      ["shell", "ui-embedding"],
      terminalManifest.requestedCapabilities,
      updateRuntimeState,
    );
  };
  const grantAndOpenTerminalWorkspace = (manifest: AddOnManifest) => {
    updateRuntimeState((draft) => {
      const installation = draft.installations[manifest.id];
      if (!installation) {
        return draft;
      }
      installation.installed = true;
      installation.enabled = true;
      installation.status = "enabled";
      const existingGrants = new Map(installation.grantedCapabilities.map((grant) => [grant.capability, grant]));
      const missingRequestedGrants = manifest.requestedCapabilities.filter((grant) => !existingGrants.has(grant.capability));
      installation.grantedCapabilities = [...installation.grantedCapabilities, ...missingRequestedGrants].map((grant) =>
        grant.capability === "shell" || grant.capability === "ui-embedding" ? { ...grant, granted: true } : grant,
      );
      installation.notes = ["Installed, enabled, and opened as a center-column Terminal workspace."];
      draft.uiPreferences.activeSection = "terminal";
      return draft;
    });
  };
  const browserDockEnabled = Boolean(browserManifest && browserInstallation?.installed && browserInstallation.enabled);
  const obsidianDockEnabled = Boolean(obsidianManifest && obsidianInstallation?.installed && obsidianInstallation.enabled);
  const opencodeDockEnabled = Boolean(opencodeManifest && opencodeInstallation?.installed && opencodeInstallation.enabled);
  const terminalDockEnabled = Boolean(terminalManifest && terminalInstallation?.installed && terminalInstallation.enabled);
  const addOnNavItems = [
    ...(obsidianDockEnabled
      ? [{ id: "obsidian" as Section, label: obsidianManifest?.name ?? "Obsidian", eyebrow: "vault", icon: "archive" as DockIconId, pinned: true }]
      : []),
    ...(browserDockEnabled
      ? [{ id: "browser" as Section, label: browserManifest?.name ?? "Browser", eyebrow: "web", icon: "browser" as DockIconId, pinned: true }]
      : []),
    ...(opencodeDockEnabled
      ? [{ id: "opencode" as Section, label: opencodeManifest?.name ?? "OpenCode", eyebrow: "code", icon: "opencode" as DockIconId, pinned: true }]
      : []),
    ...(terminalDockEnabled
      ? [
          {
            id: "terminal" as Section,
            label: terminalManifest?.name ?? "Terminal",
            eyebrow: "shell",
            icon: "terminal" as DockIconId,
            pinned: true,
          },
        ]
      : []),
  ];
  const visibleNavItems = addOnNavItems.length
    ? [
        ...navItems.slice(0, 4),
        ...addOnNavItems,
        ...navItems.slice(4),
      ]
    : navItems;

  return (
    <div className="app-zoom-viewport" style={zoomStyle}>
      <div className="app-zoom-stage">
        <div
          className={`shell ${state.uiPreferences.chatSidebarOpen ? "chat-open" : "chat-closed"} layout-${state.uiPreferences.workspaceLayout}`}
          style={shellStyle}
        >
      <header className="system-topbar" aria-label="ResonantOS system bar">
        <div className="system-menu">
          <button type="button" className="system-logo-button" title="ResonantOS Home" onClick={() => setSection("overview")}>
            Resonant<span>OS</span>
          </button>
          <span className="system-active-app">
            {recoveryModeActive ? "Emergency Recovery" : visibleNavItems.find((item) => item.id === currentSection)?.label}
          </span>
        </div>
        <div className="system-status-strip">
          <button
            type="button"
            className="system-icon-button"
            title={
              state.uiPreferences.workspaceLayout === "chat-main"
                ? "Move chat back to the right"
                : "Move chat beside the launcher"
            }
            aria-label={
              state.uiPreferences.workspaceLayout === "chat-main"
                ? "Move chat back to the right"
                : "Move chat beside the launcher"
            }
            onClick={toggleWorkspaceLayout}
          >
            <VendorIcon
              icon={
                state.uiPreferences.workspaceLayout === "chat-main"
                  ? "layout-sidebar-right-collapse"
                  : "layout-sidebar-left-expand"
              }
            />
          </button>
          <span
            className={`system-health ${strategistRecoveryActive ? "warning" : "ready"}`}
            title={`${recoveryModeActive ? "Recovery Active" : strategistRecoveryActive ? "Local runtime active" : "System Ready"} · ${activeRuntimeNode?.label ?? "No runtime"}`}
            aria-label={`${recoveryModeActive ? "Recovery Active" : strategistRecoveryActive ? "Local runtime active" : "System Ready"} · ${activeRuntimeNode?.label ?? "No runtime"}`}
          />
          <button type="button" className="system-icon-button" title="Help and documentation" aria-label="Help and documentation" onClick={() => setSection("settings")}>
            <SystemTopIcon icon="help" />
          </button>
          <button
            type="button"
            className={`system-icon-button system-emergency-button ${recoveryModeActive ? "active" : ""}`}
            onClick={() =>
              setRecoveryMode(
                !recoveryModeActive,
                updateRuntimeState,
                setChatNotice,
                setAgentActivityLabel,
                setSelectedChatModel,
              )
            }
            disabled={chatBusy}
            title={recoveryModeActive ? "Exit Emergency Recovery mode" : "Open Emergency Resurrection mode"}
            aria-label={recoveryModeActive ? "Exit Recovery" : "Resurrect Local"}
          >
            <SystemTopIcon icon="resurrect" />
          </button>
          <span>{systemClockLabel}</span>
        </div>
      </header>

      <aside className="sidebar app-dock" aria-label="ResonantOS app launcher">
        <nav className="nav-list">
          {visibleNavItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${currentSection === item.id ? "active" : ""} ${item.pinned ? "pinned" : ""}`}
              onClick={() => setSection(item.id)}
              aria-label={item.label}
              title={`${item.label} · ${item.eyebrow}`}
            >
              <span className="nav-icon" aria-hidden="true">
                <DockIcon icon={item.icon} />
              </span>
              <span className="nav-label">{item.label}</span>
              <small>{item.eyebrow}</small>
            </button>
          ))}
        </nav>
      </aside>

      <main className="main-shell">

        {recoveryModeActive && (
          <div className="inline-notice warning recovery-notice">
            Recovery mode is active. Augmentor and archive ingest are offline while the Resonant Engineer Agent handles diagnosis and repair.
          </div>
        )}

        <section
          className={`content-grid ${recoveryModeActive ? "recovery-active" : ""} ${
            !recoveryModeActive && currentSection === "browser" ? "browser-active" : ""
          } ${
            !recoveryModeActive && currentSection === "terminal" ? "terminal-active" : ""
          } ${
            !recoveryModeActive && currentSection === "opencode" ? "opencode-active" : ""
          }`}
        >
          {recoveryModeActive ? (
            <RecoveryWorkspace
              state={state}
              activeRouteLabel={activeRuntimeNode?.label ?? "No live node"}
              activeModel={activeChatModel || "Missing"}
              recoveryRuntimeStatus={recoveryRuntimeStatus}
              recoveryCandidates={recoveryCandidates}
              recoveryBusy={chatBusy}
              recoveryActivityLabel={agentActivityLabel}
              onStartRecovery={startRecoveryRunbook}
              onPromoteCandidate={(candidate) =>
                promoteRecoveryRoute(
                  candidate,
                  updateRuntimeState,
                  setSelectedChatModel,
                  setChatNotice,
                  setAgentActivityLabel,
                )
              }
            />
          ) : currentSection === "overview" ? (
            <OverviewWorkspace
              state={state}
              manifests={allManifests}
              displayedStrategistName={displayedStrategistName}
              providerLabel={routedProviderLabel(strategistRoute)}
              onOpenArchive={() => setSection("archive")}
              onOpenDelegation={() => setSection("delegation")}
              onOpenAddons={() => setSection("addons")}
              onOpenBrowser={() => setSection("browser")}
              onOpenOpenCode={() => setSection("opencode")}
              onGrantBrowserVisibleAccess={grantBrowserVisibleAccess}
              onOpenSettings={() => setSection("settings")}
            />
          ) : null}

          {!recoveryModeActive && currentSection === "strategist" && (
            <StrategistWorkspace
              state={state}
              displayedStrategistName={displayedStrategistName}
              onStrategistRename={(value) => renameStrategistIdentity(value, updateRuntimeState)}
              onToggleChannel={(channelId) => toggleStrategistChannel(channelId, updateRuntimeState)}
            />
          )}

          {!recoveryModeActive && currentSection === "archive" && (
            <ArchiveWorkspace
              state={state}
              focusTarget={archiveFocusTarget}
              archiveStatusBusy={archiveStatusBusy}
              archiveStatus={archiveStatus}
              archiveSearchBusy={archiveSearchBusy}
              archiveSearchResult={archiveSearchResult}
              archiveDocumentBusy={archiveDocumentBusy}
              archiveDocument={archiveDocument}
              archiveQueueBusy={archiveQueueBusy}
              archiveQueue={archiveQueue}
              archiveReviewArtifacts={archiveReviewArtifacts}
              archiveProcessResult={archiveProcessResult}
              archiveReviewDecisionResult={archiveReviewDecisionResult}
              archivePromotionResult={archivePromotionResult}
              archiveTolBundles={archiveTolBundles}
              archiveTolBundleResult={archiveTolBundleResult}
              archiveSourceScanBusy={archiveSourceScanBusy}
              archiveSourceScanResult={archiveSourceScanResult}
              archiveImportedLibraries={archiveImportedLibraries}
              archiveClassificationReview={archiveClassificationReview}
              archiveReorganisationPlan={archiveReorganisationPlan}
              archiveLibraryImportResult={archiveLibraryImportResult}
              archiveLibraryPreflightResult={archiveLibraryPreflightResult}
              ingestProbeBusy={archiveProbeBusy}
              ingestProbeResult={archiveProbeResult}
              onRefreshArchiveStatus={() => void refreshArchiveRuntime()}
              onRefreshArchiveSourceRegistry={() => void refreshArchiveSourceRegistry()}
              onRefreshArchiveQueue={() => void refreshArchiveQueue()}
              onRunArchiveSearch={(query) => void runArchiveSearch(query)}
              onOpenArchiveDocument={(path) => void openArchiveDocument(path)}
              onQueueArchiveSource={(source) => void queueArchiveSource(source)}
              onScanSourceFolders={(rootPath) => void runArchiveSourceFolderScan(rootPath)}
              onPickLibraryFolder={runPickArchiveLibraryFolder}
              onPreflightLibrary={(sourcePath) => void runArchiveLibraryPreflight(sourcePath)}
              onAskAugmentorAboutPreflight={(report) => void startArchivePreflightAugmentorSession(report)}
              onOpenClassificationReview={(classificationManifestPath) => void openArchiveClassificationReview(classificationManifestPath)}
              onGenerateReorganisationPlan={(classificationManifestPath) => void runArchiveReorganisationPlan(classificationManifestPath)}
              onImportLibrary={(input) => void runArchiveLibraryImport(input)}
              onQueueWatchedSource={(source) => void queueWatchedArchiveSource(source)}
              onProcessArchiveRequest={(requestFile) => void runArchiveQueuedRequest(requestFile)}
              onApproveReviewArtifact={(artifactFile) => void runArchiveReviewDecision(artifactFile, "approve", "strategist.core")}
              onEscalateReviewArtifact={(artifactFile) => void runArchiveReviewDecision(artifactFile, "escalate", "strategist.core")}
              onRejectReviewArtifact={(artifactFile) => void runArchiveReviewDecision(artifactFile, "reject", "strategist.core")}
              onPromoteReviewArtifact={(artifactFile) => void runArchivePromotion(artifactFile)}
              onRefreshTolBundles={() => void refreshArchiveTolBundles()}
              onBuildTolBundle={(sessionId) => void runArchiveTolBundleBuild(sessionId)}
              onRunIngestProbe={() => void runArchiveIngestProbe()}
            />
          )}

          {!recoveryModeActive && currentSection === "delegation" && (
            <DelegationWorkspace
              chatBusy={chatBusy}
              onStartWorkspace={async (workspaceId) => {
                await sendStrategistMessage(`start engineer task ${workspaceId}`);
              }}
              onAskAugmentor={async (message) => {
                await sendStrategistMessage(message);
              }}
            />
          )}

          {!recoveryModeActive && currentSection === "browser" && (
            <BrowserWorkspace
              manifest={browserManifest}
              installation={browserInstallation}
              workspaceState={state.uiPreferences.browserWorkspace}
              onWorkspaceStateChange={updateBrowserWorkspaceState}
              onConfigureAddon={() => setSection("addons")}
              onGrantVisibleAccess={grantBrowserVisibleAccess}
              onShowNativeWebview={showNativeBrowserWebview}
              onResizeNativeWebview={resizeNativeBrowserWebview}
              onHideNativeWebview={hideNativeBrowserWebview}
              onSyncControlledSession={syncControlledBrowserSession}
              onReadActivePage={readActiveBrowserPage}
            />
          )}

          {!recoveryModeActive && (
            <OpenCodeWorkspace
              active={currentSection === "opencode"}
              manifest={opencodeManifest}
              installation={opencodeInstallation}
              onConfigureAddon={() => {
                setSelectedAddonId("addon.opencode");
                setSection("addons");
              }}
              onGrantWorkspaceAccess={grantOpenCodeWorkspaceAccess}
              onWorkspacePathChange={updateOpenCodeWorkspacePath}
            />
          )}

          {!recoveryModeActive && currentSection === "terminal" && (
            <TerminalWorkspace
              manifest={terminalManifest}
              installation={terminalInstallation}
              onConfigureAddon={() => {
                setSelectedAddonId("addon.terminal");
                setSection("addons");
              }}
              onGrantWorkspaceAccess={grantTerminalWorkspaceAccess}
            />
          )}

          {!recoveryModeActive && currentSection === "obsidian" && (
            <ObsidianWorkspace
              manifest={obsidianManifest}
              installation={obsidianInstallation}
              onConfigureAddon={() => {
                setSelectedAddonId("addon.obsidian");
                setSection("addons");
              }}
              onGrantWorkspaceAccess={grantObsidianWorkspaceAccess}
            />
          )}

          {!recoveryModeActive && currentSection === "addons" && (
            <AddOnsWorkspace
              search={search}
              sideloadPath={sideloadPath}
              filteredManifests={filteredManifests}
              installations={state.installations}
              selectedManifest={selectedManifest}
              selectedInstallation={selectedInstallation}
              onSearchChange={(value) => {
                startTransition(() => setSearch(value));
              }}
              onSideloadPathChange={setSideloadPath}
              onSideload={() => void handleSideload()}
              onSelectManifest={setSelectedAddonId}
              onToggleAddonInstall={(manifest) => toggleAddonInstallation(manifest, updateRuntimeState)}
              onToggleGrant={(manifestId, capability) =>
                toggleAddonCapabilityGrant(manifestId, capability, updateRuntimeState)
              }
              onGrantCapabilities={(manifestId, capabilities, requestedCapabilities) =>
                grantAddonCapabilities(manifestId, capabilities, requestedCapabilities, updateRuntimeState)
              }
              onGrantTerminalWorkspaceAccess={grantAndOpenTerminalWorkspace}
              onUpdateAddonConfig={(manifestId, config) => updateAddonConfig(manifestId, config, updateRuntimeState)}
              onAskAugmentor={async (message) => {
                await sendStrategistMessage(message);
              }}
              onOpenArchiveReview={openArchiveReview}
            />
          )}

          {!recoveryModeActive && currentSection === "settings" && (
            <SettingsWorkspace
              state={state}
              settingsSection={settingsSection}
              settingsNotice={settingsNotice}
              providerDiagnostics={providerDiagnostics}
              providerDiagnosticsBusy={providerDiagnosticsBusy}
              activeProviderProbeId={activeProviderProbeId}
              providerSmokeResults={providerSmokeResults}
              providerSmokeBusyId={providerSmokeBusyId}
              providerDrafts={providerDrafts}
              onSettingsSectionChange={setSettingsSection}
              onUpdateProvider={(profileId, field, value) =>
                updateProviderProfile(profileId, field, value, updateRuntimeState)
              }
              onProviderDraftChange={(profileId, value) =>
                setProviderDrafts((current) => ({ ...current, [profileId]: value }))
              }
              onSaveProviderSecret={(profileId) => void handleSaveProviderSecret(profileId)}
              onProbeProvider={(profileId) => void refreshProviderDiagnostics(profileId)}
              onProbeAllProviders={() => void refreshProviderDiagnostics()}
              onSmokeTestProvider={(profileId) => void runProviderSmokeTest(profileId)}
            />
          )}
        </section>
      </main>

      <StrategistChatRail
        isOpen={state.uiPreferences.chatSidebarOpen}
        mode={recoveryModeActive ? "emergency" : "strategist"}
        title={activeChatAgentName}
        eyebrow={recoveryModeActive ? "Emergency recovery console" : "Persistent Strategist Chat"}
        description={
          recoveryModeActive
            ? "The Resonant Engineer Agent handles diagnosis, recovery logging, documentation checks, and the final repair report."
            : "Primary trusted conversation channel."
        }
        activeThread={activeThread}
        strategistThreads={state.conversationThreads}
        chatProjects={state.chatProjects ?? []}
        pinnedThreadIds={state.uiPreferences.pinnedChatThreadIds}
        pinnedProjectIds={state.uiPreferences.pinnedChatProjectIds ?? []}
        availableAgents={state.agents
          .filter((agent) => agent.id === "strategist.core" || agent.id === state.recoverySession.engineerAgentId)
          .filter((agent) => state.channels.some((channel) => channel.owningAgentId === agent.id && channel.enabled))
          .map((agent) => ({
            id: agent.id,
            displayName: agent.id === "strategist.core" ? displayedStrategistName : agent.displayName,
            shortLabel: agent.id === "strategist.core" ? "A" : "E",
          }))}
        activeAgentId={activeThread?.owningAgentId ?? (recoveryModeActive ? state.recoverySession.engineerAgentId : "strategist.core")}
        channels={state.channels}
        chatBusy={chatBusy}
        chatCanStop={chatRunPhase !== "idle"}
        chatSupportsAbort={activeRoute.executionAdapter?.supportsAbort === true}
        chatRunPhase={chatRunPhase}
        chatNotice={chatNotice}
        composer={composer}
        attachments={attachments}
        dictating={dictating}
        dictationAvailable={dictationAvailable}
        activeChatModel={activeChatModel}
        availableModels={activeProvider?.allowedModels ?? []}
        thinkingDepth={thinkingDepth}
        contextUsageLabel={contextUsageLabel}
        contextUsageRatio={contextUsageRatio}
        contextUsageTitle={contextUsageTitle}
        contextBudget={contextBudget}
        compactState={latestCompactState}
        historyOpen={state.uiPreferences.chatHistoryOpen}
        activityLabel={agentActivityLabel}
        recoveryRuntimeStatus={
          recoveryModeActive
            ? {
                activeRouteLabel: activeRuntimeNode?.label ?? "No live node",
                activeModel: activeChatModel || "Missing",
                targetModel: recoveryRuntimeStatus?.targetModel ?? "batiai/gemma4-e2b:q4",
                available: recoveryRuntimeStatus?.available ?? false,
                installed: recoveryRuntimeStatus?.recoveryModelInstalled ?? false,
                running: recoveryRuntimeStatus?.recoveryModelRunning ?? false,
                runningModels: recoveryRuntimeStatus?.runningModels ?? [],
              }
            : null
        }
        chatScrollAnchorRef={chatScrollAnchorRef}
        fileInputRef={fileInputRef}
        onCreateNewChat={(agentId, projectId) =>
          createAgentChatThreadAction({
            agentId,
            projectId,
            state,
            updateRuntimeState,
            setComposer,
            setAttachments,
            setChatNotice,
          })
        }
        onCreateProject={(title) =>
          createChatProjectAction({
            title,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onSetHistoryOpen={setChatHistoryOpen}
        onToggleSidebar={toggleChatSidebar}
        onSetActiveThread={(threadId) =>
          activateChatThread(threadId, updateRuntimeState, setComposer, setChatNotice, setAttachments)
        }
        onTogglePinnedThread={(threadId) => togglePinnedChatThreadAction({ threadId, updateRuntimeState })}
        onRenameThread={(threadId, title) =>
          renameChatThreadAction({
            threadId,
            title,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onMoveThreadToProject={(threadId, projectId) =>
          moveChatThreadToProjectAction({
            threadId,
            projectId,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onDeleteThread={(threadId) =>
          deleteChatThreadAction({
            activeThread,
            threadId,
            updateRuntimeState,
            setComposer,
            setAttachments,
            setChatNotice,
          })
        }
        onBranchThread={(threadId) =>
          branchChatThreadAction({
            threadId,
            updateRuntimeState,
            setComposer,
            setAttachments,
            setChatNotice,
          })
        }
        onTogglePinnedProject={(projectId) => togglePinnedChatProjectAction({ projectId, updateRuntimeState })}
        onRenameProject={(projectId, title) =>
          renameChatProjectAction({
            projectId,
            title,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onBranchProject={(projectId) =>
          branchChatProjectAction({
            projectId,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onDeleteProject={(projectId) =>
          deleteChatProjectAction({
            projectId,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onSelectAgent={(agentId) =>
          selectChatAgentAction({
            agentId,
            state,
            updateRuntimeState,
            setComposer,
            setChatNotice,
            setAttachments,
          })
        }
        onComposerChange={setComposer}
        onSend={() => void sendStrategistMessage()}
        onStopGeneration={() =>
          stopChatGenerationAction({
            chatBusy,
            activeThread,
            activeChatRunTokenRef,
            updateRuntimeState,
            setChatBusy,
            setChatRunPhase,
            setAgentActivityLabel,
            setChatNotice,
          })
        }
        onCompactThread={() =>
          compactActiveChatContextAction({
            activeThread,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onUpdateCompactMemory={(patch) =>
          updateCompactMemoryAction({
            activeThread,
            patch,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onSaveMessageToArchive={(message) => {
          if (!activeThread) {
            return;
          }
          void saveChatMessageToArchiveIntake({
            thread: activeThread,
            message,
            setChatNotice,
            setArchiveQueueBusy,
            setArchiveQueue,
            setArchiveReviewArtifacts,
            errorMessageOf,
          });
        }}
        onBranchFromMessage={(message) =>
          branchChatFromMessageAction({
            activeThread,
            message,
            updateRuntimeState,
            setComposer,
            setAttachments,
            setChatNotice,
          })
        }
        onEditUserMessage={(message) =>
          editUserMessageAction({
            activeThread,
            message,
            updateRuntimeState,
            setComposer,
            setChatNotice,
          })
        }
        onDeleteMessage={(message) =>
          deleteChatMessageAction({
            message,
            updateRuntimeState,
            setChatNotice,
          })
        }
        onToggleDictation={() =>
          toggleComposerDictation({
            dictating,
            speechRecognitionRef,
            setDictating,
            setComposer,
            setChatNotice,
            errorMessageOf,
          })
        }
        onModelChange={setSelectedChatModel}
        onThinkingDepthChange={setThinkingDepth}
        onFileAttach={(files) => void attachComposerFiles(files, setAttachments, fileInputRef)}
        onRemoveAttachment={(attachmentId) => removeComposerAttachment(attachmentId, setAttachments)}
        onStartResize={startChatRailResize}
      />
        </div>
      </div>
    </div>
  );
}

function DockIcon(props: { icon: DockIconId }) {
  if (props.icon === "opencode") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
        <use href="/icons/resonant.svg#ros-opencode" />
      </svg>
    );
  }

  if (props.icon === "terminal") {
    return (
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <use href="/icons/resonant.svg#ros-terminal" />
      </svg>
    );
  }
  return <VendorIcon icon={dockIconMap[props.icon]} />;
}

function VendorIcon(props: { icon: VendorIconId }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <use href={`/icons/vendor-ui.svg#tabler-${props.icon}`} />
    </svg>
  );
}

function SystemTopIcon(props: { icon: "help" | "resurrect" }) {
  if (props.icon === "help") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M9.5 9a2.7 2.7 0 0 1 5.1 1.3c0 2.2-2.8 2.3-2.8 4M12 18h.01M12 3.8a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4Z"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3v4M12 17v4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M3 12h4M17 12h4M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8M9.2 12a2.8 2.8 0 1 0 5.6 0 2.8 2.8 0 0 0-5.6 0Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}
