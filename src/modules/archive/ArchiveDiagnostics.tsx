// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-007-living-archive-boundaries.md

import type { ArchiveActorPolicy, ArchiveIngestProbeResult, ArchiveRuntimeStatus, ResonantShellState } from "../../core/contracts";
import { canPerformArchiveAction } from "../../core/policies";
import { resolveArchiveIngestRoute, routedProviderLabel } from "../../core/provider-service";
import { Panel } from "../../components/Panel";

type ArchiveDiagnosticsProps = {
  state: ResonantShellState;
  archiveStatus: ArchiveRuntimeStatus | null;
  ingestProbeBusy: boolean;
  ingestProbeResult: {
    probe: ArchiveIngestProbeResult;
    routeLabel: string;
    model: string;
    resolutionReason: string;
  } | null;
  onRunIngestProbe: () => void;
};

export function ArchiveDiagnostics({
  state,
  archiveStatus,
  ingestProbeBusy,
  ingestProbeResult,
  onRunIngestProbe,
}: ArchiveDiagnosticsProps) {
  const ingestRoute = resolveArchiveIngestRoute(state);

  return (
    <Panel title="Diagnostics" subtitle="Technical archive details, routes, and permission boundaries.">
      <div className="archive-diagnostics-stack">
        <details className="archive-details">
          <summary>Runtime and storage paths</summary>
          {archiveStatus ? (
            <div className="policy-columns">
              <div className="policy-block">
                <span className="eyebrow">Portable ResonantOS folder</span>
                <strong className="mono-inline">{archiveStatus.portableUserState.rootPath}</strong>
                <p>Memory: {archiveStatus.portableUserState.memoryRoot}</p>
              </div>
              <div className="policy-block">
                <span className="eyebrow">Runtime config</span>
                <strong className="mono-inline">{archiveStatus.managedRoot}</strong>
                <p>Config: {archiveStatus.configPath}</p>
              </div>
              <div className="policy-block">
                <span className="eyebrow">Mapped source roots</span>
                <ul className="mono-list">
                  {archiveStatus.sourceRoots.map((root) => (
                    <li key={`${root.role}:${root.path}`}>
                      {root.role}
                      {root.subtype ? `/${root.subtype}` : ""} · {root.path}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="policy-block">
                <span className="eyebrow">Ingest agent</span>
                <strong className="mono-inline">{archiveStatus.ingestAgent.model ?? "Not configured"}</strong>
                <p>
                  {archiveStatus.ingestAgent.provider ?? "provider missing"} ·{" "}
                  {archiveStatus.ingestAgent.reasoningEffort ?? "reasoning unset"}
                </p>
              </div>
            </div>
          ) : (
            <div className="inline-notice">No Living Archive runtime loaded yet.</div>
          )}
        </details>

        <details className="archive-details">
          <summary>Trust boundaries and permission matrix</summary>
          <div className="policy-columns">
            <div className="policy-block">
              <span className="eyebrow">Intake roots</span>
              <ul className="mono-list">
                {state.archivePolicy.intakeRoots.map((root) => (
                  <li key={root}>{root}</li>
                ))}
              </ul>
            </div>
            <div className="policy-block">
              <span className="eyebrow">Knowledge roots</span>
              <ul className="mono-list">
                {state.archivePolicy.knowledgeRoots.map((root) => (
                  <li key={root}>{root}</li>
                ))}
              </ul>
            </div>
            <div className="policy-block">
              <span className="eyebrow">Live ingest route</span>
              <strong className="mono-inline">{ingestRoute.model ?? "Missing"}</strong>
              <p>{routedProviderLabel(ingestRoute)}</p>
              <p>{ingestRoute.decision.resolutionReason}</p>
            </div>
          </div>
          <div className="table-scroll">
            <table className="policy-table">
              <thead>
                <tr>
                  <th>Actor</th>
                  <th>Read</th>
                  <th>Intake</th>
                  <th>Knowledge</th>
                  <th>Ingest request</th>
                </tr>
              </thead>
              <tbody>
                {state.archivePolicy.actorPolicies.map((policy) => (
                  <ActorPolicyRow key={policy.actorId} policy={policy} state={state} />
                ))}
              </tbody>
            </table>
          </div>
        </details>

        <details className="archive-details">
          <summary>Ingest route probe</summary>
          <div className="provider-toolbar">
            <div className="provider-toolbar-copy">
              <strong>Controlled workload execution</strong>
              <p>Validates the current archive route without writing trusted knowledge pages.</p>
            </div>
            <button type="button" className="button-secondary touch-action" onClick={onRunIngestProbe} disabled={ingestProbeBusy}>
              {ingestProbeBusy ? "Running probe..." : "Run Ingest Probe"}
            </button>
          </div>
          {ingestProbeResult ? (
            <article className="provider-card">
              <div className="provider-head">
                <div>
                  <strong>{ingestProbeResult.probe.sourceLabel}</strong>
                  <p>
                    {ingestProbeResult.model} · {ingestProbeResult.routeLabel}
                  </p>
                </div>
                <span className="tone tone-active">{ingestProbeResult.resolutionReason}</span>
              </div>
              <p>{ingestProbeResult.probe.summary}</p>
              <p className="provider-scope">Checked at: {ingestProbeResult.probe.checkedAt}</p>
            </article>
          ) : (
            <div className="inline-notice">No ingest probe has run yet.</div>
          )}
        </details>
      </div>
    </Panel>
  );
}

function ActorPolicyRow({ policy, state }: { policy: ArchiveActorPolicy; state: ResonantShellState }) {
  return (
    <tr>
      <td>
        <strong>{policy.actorId}</strong>
        <p>{policy.actorType}</p>
      </td>
      <td>{canPerformArchiveAction(state, policy.actorId, "archive-read") ? policy.readScopes.join(", ") : "blocked"}</td>
      <td>
        {canPerformArchiveAction(state, policy.actorId, "archive-intake-write") ? policy.intakeWriteScopes.join(", ") : "blocked"}
      </td>
      <td>{canPerformArchiveAction(state, policy.actorId, "archive-knowledge-write") ? "allowed" : "blocked"}</td>
      <td>{canPerformArchiveAction(state, policy.actorId, "archive-ingest-request") ? "allowed" : "blocked"}</td>
    </tr>
  );
}
