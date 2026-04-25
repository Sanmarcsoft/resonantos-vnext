// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-015-delegation-fabric-addon-catalog-native-tools.md

import { useEffect, useState } from "react";
import type { TaskWorkspace } from "../../core/contracts";
import { requestListTaskWorkspaces } from "../../core/runtime";

type DelegationWorkspaceProps = {
  chatBusy: boolean;
  onStartWorkspace: (workspaceId: string) => Promise<void>;
};

const errorMessageOf = (error: unknown): string =>
  typeof error === "string" ? error : error instanceof Error ? error.message : "Unable to load delegation workspaces.";

export function DelegationWorkspace({ chatBusy, onStartWorkspace }: DelegationWorkspaceProps) {
  const [workspaces, setWorkspaces] = useState<TaskWorkspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0] ?? null;

  const refresh = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const loaded = await requestListTaskWorkspaces();
      setWorkspaces(loaded);
      setSelectedWorkspaceId((current) =>
        current && loaded.some((workspace) => workspace.id === current) ? current : (loaded[0]?.id ?? null),
      );
    } catch (error) {
      setNotice(errorMessageOf(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const startWorkspace = async (workspaceId: string) => {
    setNotice("Starting the Engineer task through Augmentor.");
    await onStartWorkspace(workspaceId);
    await refresh();
  };

  return (
    <div className="delegation-workspace">
      <section className="delegation-hero-panel">
        <div>
          <span className="eyebrow">Delegation Monitor</span>
          <h2>Supervise work Augmentor delegates to agents and add-ons.</h2>
          <p>
            Augmentor remains the manager. This page makes delegated tasks visible, auditable, and touch-friendly so the
            human can start, review, and later approve outputs without hunting through chat history.
          </p>
        </div>
        <button type="button" className="button-secondary touch-action" onClick={() => void refresh()} disabled={busy}>
          {busy ? "Refreshing..." : "Refresh"}
        </button>
      </section>

      {notice ? <div className="inline-notice delegation-notice">{notice}</div> : null}

      <section className="delegation-grid">
        <div className="delegation-list-panel" aria-label="Delegation task workspaces">
          <div className="workspace-section-head">
            <div>
              <span className="eyebrow">Task workspaces</span>
              <h3>{workspaces.length ? `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}` : "No tasks yet"}</h3>
            </div>
          </div>

          <div className="delegation-task-list">
            {workspaces.length ? (
              workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  className={`delegation-task-card ${selectedWorkspace?.id === workspace.id ? "active" : ""}`}
                  onClick={() => setSelectedWorkspaceId(workspace.id)}
                >
                  <span className="delegation-task-orb" aria-hidden="true">
                    R-EG
                  </span>
                  <span>
                    <strong>{workspaceTitle(workspace)}</strong>
                    <small>{workspace.packetId}</small>
                    <em>{workspace.id}</em>
                  </span>
                </button>
              ))
            ) : (
              <div className="delegation-empty-state">
                <strong>No delegated task workspaces found.</strong>
                <p>Ask Augmentor to delegate a diagnostic or repair task to the Engineer. It will appear here before execution.</p>
              </div>
            )}
          </div>
        </div>

        <section className="delegation-detail-panel" aria-label="Selected delegation workspace">
          {selectedWorkspace ? (
            <DelegationWorkspaceDetail workspace={selectedWorkspace} chatBusy={chatBusy} onStartWorkspace={startWorkspace} />
          ) : (
            <div className="delegation-empty-state large">
              <span className="eyebrow">Waiting for work</span>
              <h3>Delegation starts from Augmentor.</h3>
              <p>
                The monitor does not invent tasks. It supervises task workspaces created by Augmentor from an explicit
                user request.
              </p>
            </div>
          )}
        </section>
      </section>
    </div>
  );
}

function DelegationWorkspaceDetail({
  workspace,
  chatBusy,
  onStartWorkspace,
}: {
  workspace: TaskWorkspace;
  chatBusy: boolean;
  onStartWorkspace: (workspaceId: string) => Promise<void>;
}) {
  return (
    <>
      <div className="delegation-detail-head">
        <div>
          <span className="eyebrow">Selected workspace</span>
          <h3>{workspaceTitle(workspace)}</h3>
          <p>{workspace.id}</p>
        </div>
        <span className="app-status app-status-warning">ready</span>
      </div>

      <div className="delegation-action-row">
        <button
          type="button"
          className="button-primary touch-action"
          onClick={() => void onStartWorkspace(workspace.id)}
          disabled={chatBusy}
        >
          {chatBusy ? "Agent Busy" : "Start Engineer Task"}
        </button>
        <button type="button" className="button-secondary touch-action" disabled>
          Review Result Soon
        </button>
      </div>

      <div className="delegation-path-grid">
        <PathCard label="TASK.md" path={workspace.taskMarkdownPath} />
        <PathCard label="Packet" path={workspace.packetPath} />
        <PathCard label="Result" path={workspace.resultPath} />
        <PathCard label="Verification" path={workspace.verificationPath} />
        <PathCard label="Audit folder" path={workspace.logsPath} />
        <PathCard label="Artifacts" path={workspace.artifactsPath} />
      </div>
    </>
  );
}

function PathCard({ label, path }: { label: string; path: string }) {
  return (
    <div className="delegation-path-card">
      <span>{label}</span>
      <code>{path}</code>
    </div>
  );
}

function workspaceTitle(workspace: TaskWorkspace): string {
  return workspace.id
    .replace(/^workspace-/, "")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
