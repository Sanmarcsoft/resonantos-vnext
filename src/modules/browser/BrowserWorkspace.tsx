// Intent citation: docs/architecture/ADR-006-addon-runtime-sdk.md
// Intent citation: docs/architecture/ADR-017-resonant-browser-addon.md

import { FormEvent, useEffect, useRef, useState } from "react";
import type {
  AddOnInstallation,
  AddOnManifest,
  BrowserNativeWebviewBounds,
  BrowserWorkspaceState,
  BrowserWorkspaceTabState,
  CapabilityGrant,
} from "../../core/contracts";

type BrowserWorkspaceProps = {
  manifest?: AddOnManifest;
  installation?: AddOnInstallation;
  workspaceState: BrowserWorkspaceState;
  onWorkspaceStateChange: (state: BrowserWorkspaceState) => void;
  onConfigureAddon: () => void;
  onGrantVisibleAccess?: () => void;
  onShowNativeWebview?: (input: { url: string; bounds: BrowserNativeWebviewBounds; navigate: boolean }) => Promise<string>;
  onResizeNativeWebview?: (bounds: BrowserNativeWebviewBounds) => Promise<void>;
  onHideNativeWebview?: () => Promise<void>;
  onSyncControlledSession?: (url: string) => Promise<string>;
  onReadActivePage?: (url: string) => Promise<string>;
};

const DEFAULT_BROWSER_URL = "https://resonantos.com";
const NATIVE_WEBVIEW_CHROME_GUARD_PX = 56;

const createBrowserTab = (id: string, url = DEFAULT_BROWSER_URL): BrowserWorkspaceTabState => ({
  id,
  label: labelFromUrl(url),
  url,
  history: [url],
  historyIndex: 0,
});

const hasGrant = (installation: AddOnInstallation | undefined, capability: CapabilityGrant["capability"]): boolean =>
  Boolean(installation?.enabled && installation.grantedCapabilities.some((grant) => grant.capability === capability && grant.granted));

const normalizeBrowserUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_BROWSER_URL;
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

function labelFromUrl(url: string): string {
  try {
    return new URL(url).hostname || "Browser";
  } catch {
    return "Browser";
  }
}

function isSafeBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function BrowserWorkspace({
  manifest,
  installation,
  workspaceState,
  onWorkspaceStateChange,
  onConfigureAddon,
  onGrantVisibleAccess,
  onShowNativeWebview,
  onResizeNativeWebview,
  onHideNativeWebview,
  onSyncControlledSession,
  onReadActivePage,
}: BrowserWorkspaceProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLFormElement | null>(null);
  const tabs = workspaceState.tabs.length ? workspaceState.tabs : [createBrowserTab("tab-1")];
  const activeTabId = tabs.some((tab) => tab.id === workspaceState.activeTabId) ? workspaceState.activeTabId : tabs[0].id;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const [draftUrl, setDraftUrl] = useState(activeTab?.url ?? DEFAULT_BROWSER_URL);
  const [error, setError] = useState("");
  const [controlledActionStatus, setControlledActionStatus] = useState("");

  const networkGranted = hasGrant(installation, "network");
  const embeddingGranted = hasGrant(installation, "ui-embedding");
  const browserControlGranted = hasGrant(installation, "browser-control");
  const browserReady = networkGranted && embeddingGranted && browserControlGranted;
  const canGoBack = Boolean(activeTab && activeTab.historyIndex > 0);
  const canGoForward = Boolean(activeTab && activeTab.historyIndex < activeTab.history.length - 1);

  const measureNativeBounds = (): BrowserNativeWebviewBounds | null => {
    const element = viewportRef.current;
    if (!element) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const toolbarRect = toolbarRef.current?.getBoundingClientRect();
    // Intent citation: ADR-017. Native child webviews are positioned by the host,
    // and macOS can report a Y origin that lands above the React browser chrome.
    // Keep a defensive guard so the live surface never covers tabs or the URL bar.
    const safeTop = Math.max(rect.top, toolbarRect?.bottom ?? rect.top) + NATIVE_WEBVIEW_CHROME_GUARD_PX;
    const safeLeft = rect.left + 1;
    return {
      x: safeLeft,
      y: safeTop,
      width: Math.max(1, rect.right - safeLeft - 1),
      height: Math.max(1, rect.bottom - safeTop - 1),
    };
  };

  useEffect(() => {
    setDraftUrl(activeTab?.url ?? DEFAULT_BROWSER_URL);
  }, [activeTab?.url]);

  useEffect(() => {
    if (!browserReady || !activeTab || !onShowNativeWebview) {
      return;
    }

    let cancelled = false;
    const showNativeWebview = async (navigate: boolean) => {
      const bounds = measureNativeBounds();
      if (!bounds) {
        return;
      }
      try {
        const status = await onShowNativeWebview({ url: activeTab.url, bounds, navigate });
        if (!cancelled) {
          setControlledActionStatus(status);
        }
      } catch (error) {
        if (!cancelled) {
          setError(error instanceof Error ? error.message : "Native Browser webview failed to open.");
        }
      }
    };

    const animationFrame = window.requestAnimationFrame(() => {
      void showNativeWebview(workspaceState.controlledSession.status !== "ready");
    });

    const resizeNativeWebview = () => {
      const bounds = measureNativeBounds();
      if (bounds && onResizeNativeWebview) {
        void onResizeNativeWebview(bounds).catch(() => undefined);
      }
    };
    const observer =
      typeof ResizeObserver === "undefined" || !viewportRef.current ? null : new ResizeObserver(resizeNativeWebview);
    if (observer && viewportRef.current) {
      observer.observe(viewportRef.current);
    }
    window.addEventListener("resize", resizeNativeWebview);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      window.removeEventListener("resize", resizeNativeWebview);
      if (onHideNativeWebview) {
        void onHideNativeWebview().catch(() => undefined);
      }
    };
  }, [activeTab?.id, browserReady]);

  const commitBrowserState = (nextTabs: BrowserWorkspaceTabState[], nextActiveTabId = activeTabId) => {
    onWorkspaceStateChange({
      activeTabId: nextTabs.some((tab) => tab.id === nextActiveTabId) ? nextActiveTabId : nextTabs[0]?.id ?? "tab-1",
      tabs: nextTabs.length ? nextTabs : [createBrowserTab("tab-1")],
      controlledSession: workspaceState.controlledSession,
    });
  };

  const navigateNativeWebview = (url: string) => {
    if (!onShowNativeWebview) {
      return;
    }
    const bounds = measureNativeBounds();
    if (bounds) {
      void onShowNativeWebview({ url, bounds, navigate: true }).catch((error) => {
        setError(error instanceof Error ? error.message : "Native Browser navigation failed.");
      });
    }
  };

  const navigateTo = (url: string, mode: "push" | "replace") => {
    const nextUrl = normalizeBrowserUrl(url);
    if (!isSafeBrowserUrl(nextUrl)) {
      setError("Browser only accepts http and https URLs in this version.");
      return;
    }
    setError("");
    commitBrowserState(
      tabs.map((tab) => {
        if (tab.id !== activeTabId) {
          return tab;
        }
        const nextHistory =
          mode === "push"
            ? [...tab.history.slice(0, tab.historyIndex + 1), nextUrl]
            : tab.history.length
              ? tab.history.map((entry, index) => (index === tab.historyIndex ? nextUrl : entry))
              : [nextUrl];
        return {
          ...tab,
          label: labelFromUrl(nextUrl),
          url: nextUrl,
          history: nextHistory,
          historyIndex: mode === "push" ? nextHistory.length - 1 : Math.max(0, tab.historyIndex),
        };
      }),
    );
    if (onSyncControlledSession) {
      void onSyncControlledSession(nextUrl).catch((error) => {
        setError(error instanceof Error ? error.message : "Controlled Browser session sync failed.");
      });
    }
    navigateNativeWebview(nextUrl);
  };

  const submitNavigation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigateTo(draftUrl, "push");
  };

  const addTab = () => {
    const id = `tab-${Date.now()}`;
    const tab = createBrowserTab(id);
    commitBrowserState([...tabs, tab], id);
    navigateNativeWebview(tab.url);
  };

  const selectTab = (tab: BrowserWorkspaceTabState) => {
    commitBrowserState(tabs, tab.id);
    navigateNativeWebview(tab.url);
  };

  const closeTab = (tabId: string) => {
    const nextTabs = tabs.length > 1 ? tabs.filter((tab) => tab.id !== tabId) : [createBrowserTab("tab-1")];
    commitBrowserState(nextTabs, tabId === activeTabId ? nextTabs[0].id : activeTabId);
  };

  const goToHistoryOffset = (offset: -1 | 1) => {
    if (!activeTab) {
      return;
    }
    const targetIndex = activeTab.historyIndex + offset;
    const targetUrl = activeTab.history[targetIndex];
    if (!targetUrl) {
      return;
    }
    setError("");
    commitBrowserState(tabs.map((tab) => (tab.id === activeTab.id ? { ...tab, url: targetUrl, historyIndex: targetIndex } : tab)));
    navigateNativeWebview(targetUrl);
  };

  const readActivePageWithHost = async () => {
    if (!activeTab || !onReadActivePage) {
      return;
    }
    setControlledActionStatus("Reading active page through governed Browser host...");
    setError("");
    try {
      const summary = await onReadActivePage(activeTab.url);
      setControlledActionStatus(summary);
    } catch (error) {
      setControlledActionStatus("");
      setError(error instanceof Error ? error.message : "Controlled Browser read failed.");
    }
  };

  if (!browserReady) {
    return (
      <div className="browser-workspace" data-testid="browser-workspace">
        <section className="browser-gate">
          <div>
            <span className="eyebrow">Capability gate</span>
            <h4>Enable Browser before opening web sessions.</h4>
            <p>
              Browser needs network, UI embedding, and browser-control grants before a live browser surface can be
              attached to the ResonantOS workspace.
            </p>
          </div>
          <button type="button" className="button-primary touch-action" onClick={onGrantVisibleAccess ?? onConfigureAddon}>
            {onGrantVisibleAccess ? "Install and grant browser access" : "Configure Browser Add-on"}
          </button>
          <button type="button" className="button-secondary touch-action" onClick={onConfigureAddon}>
            Open Add-on Settings
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="browser-workspace" data-testid="browser-workspace">
      <section className="browser-live-session" aria-label="Resonant Browser live session">
        <div className="browser-tab-strip" aria-label="Browser tabs">
          {tabs.map((tab) => (
            <div key={tab.id} className={`browser-tab ${tab.id === activeTabId ? "active" : ""}`}>
              <button type="button" onClick={() => selectTab(tab)} aria-label={`Open tab ${tab.label}`}>
                {tab.label}
              </button>
              <button
                type="button"
                aria-label={`Close tab ${tab.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button type="button" className="browser-icon-button" aria-label="New tab" onClick={addTab}>
            +
          </button>
        </div>

        <form className="browser-toolbar" ref={toolbarRef} onSubmit={submitNavigation}>
          <div className="browser-nav-cluster" aria-label="Browser navigation controls">
            <button type="button" className="browser-icon-button" aria-label="Back" onClick={() => goToHistoryOffset(-1)} disabled={!canGoBack}>
              ‹
            </button>
            <button type="button" className="browser-icon-button" aria-label="Forward" onClick={() => goToHistoryOffset(1)} disabled={!canGoForward}>
              ›
            </button>
          </div>
          <input
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            aria-label="Browser URL"
            placeholder="https://resonantos.com"
          />
          <div className="browser-nav-cluster browser-nav-cluster-right">
            <button type="button" className="browser-icon-button" aria-label="Reload" onClick={() => navigateTo(activeTab?.url ?? draftUrl, "replace")}>
              ↻
            </button>
            <button
              type="button"
              className="browser-icon-button browser-ai-button"
              aria-label="Read active page with Augmentor"
              onClick={() => void readActivePageWithHost()}
              disabled={!onReadActivePage}
            >
              A
            </button>
            <button type="submit" className="browser-icon-button browser-go-button" aria-label="Open address">
              →
            </button>
          </div>
        </form>

        <div className="browser-native-host" aria-label="Live browser viewport">
          {activeTab ? (
            <div
              ref={viewportRef}
              className="browser-native-webview-mount"
              title={`${manifest?.name ?? "Resonant Browser"} native webview: ${activeTab.label}`}
            >
              <div className="browser-native-webview-placeholder">
                Native Browser surface
                <span>Websites load in a host-owned webview, not an iframe.</span>
              </div>
            </div>
          ) : null}
          {error ? (
            <div className="browser-error" role="alert">
              {error}
            </div>
          ) : null}
          {controlledActionStatus ? <div className="browser-engine-status">{controlledActionStatus}</div> : null}
          {workspaceState.controlledSession.status !== "idle" ? (
            <div className={`browser-engine-status browser-engine-status-${workspaceState.controlledSession.status}`}>
              {workspaceState.controlledSession.status === "starting"
                ? "Syncing controlled Chromium session..."
                : workspaceState.controlledSession.status === "ready"
                  ? `Controlled Chromium ready: ${workspaceState.controlledSession.title || workspaceState.controlledSession.url || "active session"}`
                  : `Controlled Chromium error: ${workspaceState.controlledSession.error || "session unavailable"}`}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
