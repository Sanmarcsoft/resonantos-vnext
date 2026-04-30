// Intent citation: docs/architecture/ADR-006-addon-runtime-sdk.md

import { useEffect, useState } from "react";
import type { AddOnInstallation, CapabilityGrant, HermesInstallStatus } from "../../core/contracts";
import { requestHermesStatus } from "../../core/runtime";

type HermesAddonPanelProps = {
  installation: AddOnInstallation;
  requestedCapabilities: CapabilityGrant[];
  onGrantCapabilities: (capabilities: CapabilityGrant["capability"][], requestedCapabilities: CapabilityGrant[]) => void;
  onConfigChange: (config: Record<string, unknown>) => void;
};

const hasGrant = (installation: AddOnInstallation, capability: CapabilityGrant["capability"]): boolean =>
  installation.grantedCapabilities.some((grant) => grant.capability === capability && grant.granted);

const compatibilityTone = (status: HermesInstallStatus | null): string => {
  if (!status) {
    return "neutral";
  }
  if (status.compatibility === "ready") {
    return "active";
  }
  return "warning";
};

export function HermesAddonPanel({
  installation,
  requestedCapabilities,
  onGrantCapabilities,
  onConfigChange,
}: HermesAddonPanelProps) {
  const configuredProfileHome = typeof installation.config?.profileHome === "string" ? installation.config.profileHome : "";
  const [profileHome, setProfileHome] = useState(configuredProfileHome);
  const [status, setStatus] = useState<HermesInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shellGranted = hasGrant(installation, "shell");
  const providersGranted = hasGrant(installation, "providers");
  const archiveReadGranted = hasGrant(installation, "archive-read");
  const intakeGranted = hasGrant(installation, "archive-intake-write");

  const runAudit = async (overrideProfileHome = profileHome) => {
    setBusy(true);
    setError("");
    try {
      const nextStatus = await requestHermesStatus(overrideProfileHome.trim() || undefined);
      setStatus(nextStatus);
    } catch (auditError) {
      setError(auditError instanceof Error ? auditError.message : "Could not audit Hermes.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void runAudit(configuredProfileHome);
  }, [configuredProfileHome]);

  return (
    <div className="hermes-addon-panel">
      <div className="hermes-addon-head">
        <div>
          <span className="eyebrow">Hermes compatibility</span>
          <h3>Use the existing local Hermes profile</h3>
          <p>
            ResonantOS attaches to Hermes instead of replacing it. The audit checks profile health, gateway state,
            identity, memory, skills, and indexing without exposing secrets.
          </p>
        </div>
        <span className={`tone tone-${compatibilityTone(status)}`}>
          {status ? status.compatibility : busy ? "checking" : "not checked"}
        </span>
      </div>

      <div className="hermes-profile-row">
        <input
          value={profileHome}
          onChange={(event) => setProfileHome(event.target.value)}
          placeholder="Hermes profile path, defaults to ~/.hermes"
        />
        <button
          type="button"
          className="button-secondary touch-action"
          onClick={() => {
            onConfigChange({ profileHome: profileHome.trim() });
            void runAudit(profileHome);
          }}
          disabled={busy}
        >
          {busy ? "Auditing..." : "Run audit"}
        </button>
      </div>

      <div className="hermes-grant-strip">
        <span className={`tone tone-${shellGranted ? "active" : "neutral"}`}>shell {shellGranted ? "granted" : "needed"}</span>
        <span className={`tone tone-${providersGranted ? "active" : "neutral"}`}>
          providers {providersGranted ? "granted" : "optional"}
        </span>
        <span className={`tone tone-${archiveReadGranted ? "active" : "neutral"}`}>
          archive read {archiveReadGranted ? "granted" : "optional"}
        </span>
        <span className={`tone tone-${intakeGranted ? "active" : "neutral"}`}>
          intake {intakeGranted ? "granted" : "optional"}
        </span>
        <button
          type="button"
          className="button-primary touch-action"
          onClick={() => onGrantCapabilities(["shell", "providers", "archive-read", "archive-intake-write"], requestedCapabilities)}
          disabled={shellGranted && providersGranted && archiveReadGranted && intakeGranted}
        >
          {shellGranted && providersGranted && archiveReadGranted && intakeGranted
            ? "Hermes access granted"
            : "Grant Hermes bridge access"}
        </button>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {status ? (
        <>
          <div className="hermes-audit-grid">
            <div>
              <span className="eyebrow">Profile</span>
              <strong>{status.detected ? "Detected" : "Missing"}</strong>
              <p>{status.home}</p>
            </div>
            <div>
              <span className="eyebrow">Gateway</span>
              <strong>{status.gateway.running ? "Running" : status.gateway.present ? "Stale" : "Not present"}</strong>
              <p>{status.gateway.detail}</p>
            </div>
            <div>
              <span className="eyebrow">Inventory</span>
              <strong>
                {status.inventory.skillsCount} skills · {status.inventory.memoriesCount} memories
              </strong>
              <p>
                {status.inventory.sessionsCount} sessions · KB {status.inventory.kbPresent ? "present" : "missing"} · index{" "}
                {status.inventory.kbIndexPresent ? "present" : "missing"}
              </p>
            </div>
            <div>
              <span className="eyebrow">Source</span>
              <strong>{status.agentGitCommit ?? status.version ?? "Unknown"}</strong>
              <p>{status.agentSourcePath ?? status.command ?? "No runnable Hermes source found"}</p>
            </div>
          </div>

          <div className="hermes-findings">
            {status.findings.map((finding) => (
              <article key={finding.id} className={`hermes-finding ${finding.severity}`}>
                <div>
                  <span>{finding.severity}</span>
                  <strong>{finding.title}</strong>
                </div>
                <p>{finding.detail}</p>
                <p>{finding.suggestion}</p>
              </article>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
