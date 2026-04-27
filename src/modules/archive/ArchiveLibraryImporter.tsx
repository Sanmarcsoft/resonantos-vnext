// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-013-living-archive-memory-domains.md

import { useState } from "react";
import type {
  ArchiveLibraryImportMode,
  ArchiveLibraryImportResult,
  ArchiveMemoryDomain,
} from "../../core/contracts";
import { Panel } from "../../components/Panel";

type ArchiveLibraryImporterProps = {
  archiveSourceScanBusy: boolean;
  archiveLibraryImportResult: ArchiveLibraryImportResult | null;
  onPickLibraryFolder: () => Promise<string | null>;
  onImportLibrary: (input: {
    sourcePath: string;
    domain: ArchiveMemoryDomain;
    importMode: ArchiveLibraryImportMode;
    libraryName?: string;
  }) => void;
};

export function ArchiveLibraryImporter({
  archiveSourceScanBusy,
  archiveLibraryImportResult,
  onPickLibraryFolder,
  onImportLibrary,
}: ArchiveLibraryImporterProps) {
  const [libraryPath, setLibraryPath] = useState("");
  const [libraryName, setLibraryName] = useState("");
  const [libraryDomain, setLibraryDomain] = useState<ArchiveMemoryDomain>("mixed-library");
  const [libraryImportMode, setLibraryImportMode] = useState<ArchiveLibraryImportMode>("copy");
  const chooseLibraryFolder = async () => {
    const selected = await onPickLibraryFolder();
    if (selected) {
      setLibraryPath(selected);
    }
  };

  return (
    <Panel
      className="library-importer-panel"
      title="Library Importer"
      subtitle="Bring a folder or Obsidian vault into the managed ResonantOS memory system."
    >
      <div className="library-importer-intro">
        <div>
          <span className="eyebrow">Why this matters</span>
          <h3>Keep the human voice separate from outside knowledge.</h3>
          <p>
            Import mixed folders safely first. ResonantOS copies the structure, then helps classify personal knowledge,
            external material, tags, and wikilinks before anything becomes trusted AI memory.
          </p>
        </div>
        <ol className="library-importer-steps" aria-label="Library import workflow">
          <li>Choose the folder</li>
          <li>Select how to store it</li>
          <li>Review classification</li>
        </ol>
      </div>
      <form
        className="library-import-form"
        onSubmit={(event) => {
          event.preventDefault();
          onImportLibrary({
            sourcePath: libraryPath,
            domain: libraryDomain,
            importMode: libraryImportMode,
            libraryName,
          });
        }}
      >
        <section className="library-step-card">
          <div className="library-step-head">
            <span>1</span>
            <div>
              <strong>Choose source folder</strong>
              <p>Select a normal folder or an Obsidian vault. Long paths are contained here and will not affect the rest of the page.</p>
            </div>
          </div>
          <button
            type="button"
            className={`library-folder-button ${libraryPath ? "selected" : ""}`}
            aria-label="Choose folder or vault path"
            onClick={() => void chooseLibraryFolder()}
          >
            <span>{libraryPath || "Click to choose a folder or Obsidian vault"}</span>
            <strong>Browse...</strong>
          </button>
          <details className="library-manual-path">
            <summary>Advanced: type path manually</summary>
            <input
              aria-label="Manual folder or vault path"
              value={libraryPath}
              onChange={(event) => setLibraryPath(event.target.value)}
              placeholder="/Users/you/Documents/My Knowledge Folder"
            />
          </details>
        </section>

        <section className="library-step-card">
          <div className="library-step-head">
            <span>2</span>
            <div>
              <strong>Choose memory handling</strong>
              <p>Use Mixed Library when the folder contains both personal and external material.</p>
            </div>
          </div>
          <div className="library-field-grid">
            <label>
              <span>Library name</span>
              <input
                value={libraryName}
                onChange={(event) => setLibraryName(event.target.value)}
                placeholder="Optional, inferred from folder"
              />
            </label>
            <label>
              <span>Memory domain</span>
              <select value={libraryDomain} onChange={(event) => setLibraryDomain(event.target.value as ArchiveMemoryDomain)}>
                <option value="mixed-library">Mixed Library - classify with AI help</option>
                <option value="human-knowledge">Human Knowledge</option>
                <option value="external-knowledge">External Knowledge</option>
              </select>
            </label>
            <label>
              <span>Import mode</span>
              <select value={libraryImportMode} onChange={(event) => setLibraryImportMode(event.target.value as ArchiveLibraryImportMode)}>
                <option value="copy">Copy into Living Archive (recommended)</option>
                <option value="move" disabled>
                  Move into Living Archive (disabled until audited execution)
                </option>
                <option value="reference">Reference in place (advanced)</option>
              </select>
            </label>
          </div>
          <div className={`inline-notice ${libraryImportMode === "move" ? "warning" : ""}`}>
            {libraryImportMode === "copy"
              ? "Copy mode preserves the original and makes the managed ResonantOS copy the active knowledge base."
              : libraryImportMode === "move"
                ? "Move mode is disabled until explicit confirmation, audit, and rollback execution exist."
                : "Reference mode leaves files where they are. Use only when you cannot copy the source yet."}
          </div>
        </section>

        <section className="library-step-card library-import-action-card">
          <div className="library-step-head">
            <span>3</span>
            <div>
              <strong>Import and review</strong>
              <p>Non-Obsidian folders use Obsidian-compatible frontmatter, tags, and wikilinks by default.</p>
            </div>
          </div>
          <button type="submit" className="button-secondary touch-action" disabled={archiveSourceScanBusy || !libraryPath.trim()}>
            {archiveSourceScanBusy ? "Importing..." : "Import Library"}
          </button>
        </section>
      </form>
      {archiveLibraryImportResult ? (
        <article className="archive-import-result">
          <div className="archive-import-result-head">
            <div>
              <span className="eyebrow">Latest imported library</span>
              <strong>{archiveLibraryImportResult.libraryName}</strong>
              <p className="path-chip">{archiveLibraryImportResult.canonicalRoot}</p>
            </div>
            <span className="tone tone-active">{archiveLibraryImportResult.domain}</span>
          </div>
          <div className="archive-result-metrics">
            <span>{archiveLibraryImportResult.filesImported} imported</span>
            <span>{archiveLibraryImportResult.skippedFiles} skipped</span>
            <span>{archiveLibraryImportResult.importMode} mode</span>
            <span>{archiveLibraryImportResult.classificationStatus}</span>
            <span>{archiveLibraryImportResult.metadataStandard}</span>
            {archiveLibraryImportResult.recommendedAddon ? <span>Obsidian add-on recommended</span> : null}
          </div>
          {archiveLibraryImportResult.classificationManifestPath ? (
            <div className="inline-notice">
              Classification review artifact created. Open it from the Source Registry to continue through the host-owned review flow.
            </div>
          ) : null}
        </article>
      ) : null}
    </Panel>
  );
}
