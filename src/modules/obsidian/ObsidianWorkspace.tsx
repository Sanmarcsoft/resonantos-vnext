// Intent citation: docs/architecture/ADR-019-obsidian-addon-embedded-workspace.md
// Intent citation: docs/architecture/ADR-020-resonant-notes-clean-room-workspace.md

import { useEffect, useState } from "react";
import type {
  AddOnInstallation,
  AddOnManifest,
  ObsidianNotePayload,
  ObsidianNoteSummary,
  ObsidianVaultIndex,
  ObsidianWriteNoteResult,
} from "../../core/contracts";
import {
  requestObsidianNote,
  requestObsidianNoteList,
  requestObsidianVaultIndex,
  requestObsidianVaultStatus,
  requestObsidianWriteNote,
} from "../../core/runtime";
import { ObsidianMetadataPanel } from "./ObsidianMetadataPanel";
import { ObsidianVaultIndexPanel } from "./ObsidianVaultIndexPanel";
import {
  configuredObsidianVaultPath,
  hasObsidianGrant,
  noteIsDirty,
  parseObsidianMetadata,
  renderMarkdownPreview,
} from "./obsidian-workspace-model";
import "./obsidian-workspace.css";

type SidebarView = "files" | "search" | "backlinks";

type ObsidianWorkspaceProps = {
  manifest?: AddOnManifest;
  installation?: AddOnInstallation;
  onConfigureAddon: () => void;
  onGrantWorkspaceAccess: () => void | Promise<void>;
};

export function ObsidianWorkspace({
  manifest,
  installation,
  onConfigureAddon,
  onGrantWorkspaceAccess,
}: ObsidianWorkspaceProps) {
  const vaultPath = configuredObsidianVaultPath(installation);
  const filesystemGranted = hasObsidianGrant(installation, "filesystem");
  const embeddingGranted = hasObsidianGrant(installation, "ui-embedding");
  const workspaceReady = Boolean(installation?.enabled && filesystemGranted && embeddingGranted && vaultPath);
  const [notes, setNotes] = useState<ObsidianNoteSummary[]>([]);
  const [vaultIndex, setVaultIndex] = useState<ObsidianVaultIndex | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNote, setSelectedNote] = useState<ObsidianNotePayload | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [readingViewOpen, setReadingViewOpen] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>("files");
  const [busyLabel, setBusyLabel] = useState("");
  const [gateBusyLabel, setGateBusyLabel] = useState("");
  const [gateError, setGateError] = useState("");
  const [error, setError] = useState("");
  const [saveResult, setSaveResult] = useState<ObsidianWriteNoteResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!workspaceReady) {
      return;
    }
    setBusyLabel("Loading vault");
    setError("");
    requestObsidianVaultStatus(vaultPath)
      .then(() => requestObsidianNoteList(vaultPath, 500))
      .then((nextNotes) => {
        if (!cancelled) {
          setNotes(nextNotes);
          setSelectedNote(null);
          setDraftContent("");
          setSaveResult(null);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load Obsidian workspace.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusyLabel("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath, workspaceReady]);

  useEffect(() => {
    let cancelled = false;
    if (!workspaceReady) {
      setVaultIndex(null);
      return;
    }
    setBusyLabel("Indexing vault");
    requestObsidianVaultIndex(vaultPath, searchQuery, 200)
      .then((nextIndex) => {
        if (!cancelled) {
          setVaultIndex(nextIndex);
        }
      })
      .catch((indexError) => {
        if (!cancelled) {
          setError(indexError instanceof Error ? indexError.message : "Failed to index Obsidian-compatible vault.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusyLabel("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath, workspaceReady, searchQuery]);

  const openNote = async (note: ObsidianNoteSummary) => {
    if (noteIsDirty(selectedNote, draftContent)) {
      setError("Save or discard the current note before opening another note.");
      return;
    }
    setBusyLabel("Opening note");
    setError("");
    setSaveResult(null);
    try {
      const payload = await requestObsidianNote(vaultPath, note.relativePath);
      setSelectedNote(payload);
      setDraftContent(payload.content);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Failed to open Obsidian note.");
    } finally {
      setBusyLabel("");
    }
  };

  const openNotePath = (notePath: string) => {
    const note =
      notes.find((item) => item.relativePath === notePath) ??
      vaultIndex?.notes.find((item) => item.relativePath === notePath);
    if (!note) {
      setError(`Note is not available in the current vault index: ${notePath}`);
      return;
    }
    void openNote(note);
  };

  const saveNote = async () => {
    if (!selectedNote || !noteIsDirty(selectedNote, draftContent)) {
      return;
    }
    setBusyLabel("Saving note");
    setError("");
    setSaveResult(null);
    try {
      const result = await requestObsidianWriteNote({
        vaultPath,
        notePath: selectedNote.relativePath,
        content: draftContent,
        expectedModifiedAt: selectedNote.modifiedAt,
        actorId: "addon.obsidian",
      });
      setSaveResult(result);
      setSelectedNote({
        ...selectedNote,
        content: draftContent,
        sizeBytes: result.sizeBytes,
        modifiedAt: result.modifiedAt,
      });
      setNotes((current) =>
        current.map((note) =>
          note.relativePath === result.notePath
            ? {
                ...note,
                sizeBytes: result.sizeBytes,
                modifiedAt: result.modifiedAt,
              }
          : note,
        ),
      );
      setVaultIndex(await requestObsidianVaultIndex(vaultPath, searchQuery, 200));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save Obsidian note.");
    } finally {
      setBusyLabel("");
    }
  };

  const discardDraft = () => {
    if (!selectedNote) {
      return;
    }
    setDraftContent(selectedNote.content);
    setError("");
  };

  const connectWorkspace = async () => {
    setGateBusyLabel("Opening vault picker");
    setGateError("");
    try {
      await onGrantWorkspaceAccess();
    } catch (connectError) {
      setGateError(connectError instanceof Error ? connectError.message : "Failed to connect the Obsidian workspace.");
    } finally {
      setGateBusyLabel("");
    }
  };

  if (!workspaceReady) {
    const missingRequirements = [
      !installation?.enabled ? "enable the add-on" : "",
      !filesystemGranted ? "grant filesystem access" : "",
      !embeddingGranted ? "grant workspace embedding" : "",
      !vaultPath ? "choose an Obsidian vault or markdown folder" : "",
    ].filter(Boolean);
    return (
      <section className="obsidian-workspace obsidian-workspace-gate" data-testid="obsidian-workspace">
        <div>
          <span className="eyebrow">Obsidian Workspace</span>
          <h3>Connect a vault before editing inside ResonantOS.</h3>
          <p>
            {manifest?.name ?? "Obsidian"} V2 needs an enabled add-on, a selected vault, filesystem access, and the
            embedded workspace grant. The existing vault bridge remains available from Add-ons.
          </p>
          {missingRequirements.length ? (
            <p className="obsidian-workspace-gate-requirements">Next: {missingRequirements.join(", ")}.</p>
          ) : null}
          {gateBusyLabel ? <p className="obsidian-workspace-gate-status">{gateBusyLabel}...</p> : null}
          {gateError ? <p className="obsidian-workspace-gate-error">{gateError}</p> : null}
        </div>
        <div className="obsidian-workspace-actions">
          <button type="button" className="button-primary" onClick={() => void connectWorkspace()} disabled={Boolean(gateBusyLabel)}>
            {vaultPath ? "Grant workspace access" : "Connect workspace"}
          </button>
          <button type="button" className="button-secondary" onClick={onConfigureAddon}>
            Open Obsidian settings
          </button>
        </div>
      </section>
    );
  }

  const dirty = noteIsDirty(selectedNote, draftContent);
  const metadata = parseObsidianMetadata(draftContent);
  const selectedIndexedNote = selectedNote
    ? vaultIndex?.notes.find((note) => note.relativePath === selectedNote.relativePath)
    : undefined;
  const selectedFolder = selectedNote?.relativePath.includes("/")
    ? selectedNote.relativePath.split("/").slice(0, -1).join(" / ")
    : "Vault root";
  const wordCount = draftContent.trim() ? draftContent.trim().split(/\s+/).length : 0;
  const characterCount = draftContent.length;

  return (
    <section className="obsidian-workspace" data-testid="obsidian-workspace">
      <header className="obsidian-workspace-header">
        <div className="obsidian-window-tabs" aria-label="Resonant Notes tabs">
          <button type="button" className="obsidian-window-tab">
            {vaultPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "Vault"}
          </button>
          <button type="button" className="obsidian-window-tab active">
            {selectedNote?.title ?? "Select a note"}
          </button>
        </div>
        <div className="obsidian-workspace-actions">
          {busyLabel ? <span className="tone tone-neutral">{busyLabel}...</span> : null}
          {dirty ? <span className="tone tone-warning">unsaved</span> : <span className="tone tone-active">synced</span>}
          <button type="button" className="button-secondary" onClick={() => setReadingViewOpen((current) => !current)}>
            {readingViewOpen ? "Editing view" : "Reading view"}
          </button>
          <button type="button" className="button-secondary" onClick={discardDraft} disabled={!dirty}>
            Discard
          </button>
          <button type="button" className="button-primary" onClick={() => void saveNote()} disabled={!dirty || Boolean(busyLabel)}>
            Save
          </button>
        </div>
      </header>

      {error ? <div className="obsidian-workspace-alert">{error}</div> : null}
      {saveResult ? (
        <div className="obsidian-workspace-saved">
          Saved with audit: {saveResult.auditPath}
        </div>
      ) : null}

      <div className="obsidian-workspace-grid">
        <nav className="obsidian-side-icons" aria-label="Resonant Notes tools">
          <button
            type="button"
            className={sidebarView === "files" ? "active" : ""}
            onClick={() => setSidebarView("files")}
            aria-label="Show file explorer"
            title="Files"
          >
            □
          </button>
          <button
            type="button"
            className={sidebarView === "search" ? "active" : ""}
            onClick={() => setSidebarView("search")}
            aria-label="Show search"
            title="Search"
          >
            ⌕
          </button>
          <button
            type="button"
            className={sidebarView === "backlinks" ? "active" : ""}
            onClick={() => setSidebarView("backlinks")}
            aria-label="Show backlinks"
            title="Backlinks"
          >
            ⌁
          </button>
          <button type="button" aria-label="Graph view placeholder" title="Graph" disabled>
            ◇
          </button>
        </nav>

        <aside className="obsidian-workspace-tree" aria-label="Obsidian vault note list">
          <div className="obsidian-workspace-tree-header">
            <span className="eyebrow">
              {sidebarView === "files" ? vaultPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "Vault" : sidebarView}
            </span>
            <small>{notes.length} note(s)</small>
          </div>
          {sidebarView === "files" ? (
            <div className="obsidian-note-list">
              {notes.map((note) => (
                <button
                  key={note.relativePath}
                  type="button"
                  className={selectedNote?.relativePath === note.relativePath ? "active" : ""}
                  onClick={() => void openNote(note)}
                >
                  <strong>{note.title}</strong>
                  <span>{note.relativePath}</span>
                </button>
              ))}
            </div>
          ) : (
            <ObsidianVaultIndexPanel
              index={vaultIndex}
              selectedNote={selectedIndexedNote}
              searchQuery={searchQuery}
              busy={busyLabel === "Indexing vault"}
              mode={sidebarView}
              onSearchQueryChange={setSearchQuery}
              onOpenNotePath={openNotePath}
            />
          )}
        </aside>

        <main className="obsidian-note-main">
          <div className="obsidian-note-breadcrumb">
            <span>{selectedFolder}</span>
            <strong>{selectedNote?.title ?? "No note selected"}</strong>
          </div>
          <ObsidianMetadataPanel metadata={metadata} />
          {readingViewOpen ? (
            <article className="obsidian-preview-panel" aria-label="Obsidian markdown preview">
              {selectedNote ? (
                <div dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(draftContent) }} />
              ) : (
                <p className="muted-copy">Preview appears after selecting a note.</p>
              )}
            </article>
          ) : (
            <article className="obsidian-editor-panel" aria-label="Obsidian markdown editor">
              {selectedNote ? (
                <textarea
                  value={draftContent}
                  onChange={(event) => setDraftContent(event.target.value)}
                  aria-label="Obsidian note editor"
                  spellCheck
                />
              ) : (
                <div className="obsidian-empty-editor">
                  <h4>Select a note to edit.</h4>
                  <p>Writes are audited and versioned before ResonantOS overwrites the vault file.</p>
                </div>
              )}
            </article>
          )}
          <footer className="obsidian-status-bar" aria-label="Obsidian workspace status">
            <span>{selectedIndexedNote?.backlinks.length ?? 0} backlinks</span>
            <span>{readingViewOpen ? "Reading view" : "Editing view"}</span>
            <span>{wordCount.toLocaleString()} words</span>
            <span>{characterCount.toLocaleString()} characters</span>
          </footer>
        </main>
      </div>
    </section>
  );
}
