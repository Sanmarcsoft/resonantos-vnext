// Intent citation: docs/architecture/ADR-016-haus-vm-hermes-replacement.md
//
// Embeds the polished /chat page served from haus.matthewstevens.org
// (the haus-vm widget bridge backed by Hermes Agency Stage 1) inside the
// resonantos-vnext shell. The remote page already handles the full chat
// loop: composer, markdown rendering, conversation history, typing
// indicator, persona persistence in its own localStorage.
//
// Rationale for the iframe shape rather than a native React port: the
// remote page evolves on its own release cadence with the haus-vm
// service. Embedding it via iframe means UI improvements there flow into
// the desktop shell automatically; the desktop side stays a thin frame
// with operator metadata.

import { useState } from "react";
import { ZorinNative } from "./ZorinNative";
import "./zorin-workspace.css";

const CANONICAL_CHAT_URL = "https://haus.matthewstevens.org/chat";

type ZorinSurface = "native" | "remote";

type ZorinWorkspaceProps = {
  active: boolean;
  chatUrl?: string;
  initialSurface?: ZorinSurface;
};

export function ZorinWorkspace({ active, chatUrl, initialSurface = "native" }: ZorinWorkspaceProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const [revealEndpoint, setRevealEndpoint] = useState(false);
  const [surface, setSurface] = useState<ZorinSurface>(initialSurface);
  const url = chatUrl ?? CANONICAL_CHAT_URL;

  if (!active) {
    return null;
  }

  return (
    <section className="zorin-workspace" aria-label="Chat with Zorin">
      <header className="zorin-workspace__header">
        <div className="zorin-workspace__title">
          <span className="zorin-workspace__avatar" aria-hidden="true">
            Z
          </span>
          <div className="zorin-workspace__title-text">
            <h2>Zorin</h2>
            <p>Autonomous agent on haus-vm. Hermes Agency Stage 1, gemma4 via Ollama.</p>
          </div>
        </div>
        <div className="zorin-workspace__actions">
          <button
            type="button"
            className="zorin-workspace__action"
            onClick={() => setSurface((current) => (current === "native" ? "remote" : "native"))}
            aria-pressed={surface === "native"}
            title="Toggle between the native OpenUI surface and the iframe fallback"
          >
            {surface === "native" ? "Surface: native" : "Surface: remote"}
          </button>
          {surface === "remote" && (
            <button
              type="button"
              className="zorin-workspace__action"
              onClick={() => setRevealEndpoint((current) => !current)}
              aria-pressed={revealEndpoint}
            >
              {revealEndpoint ? "Hide endpoint" : "Show endpoint"}
            </button>
          )}
          {surface === "remote" && (
            <button
              type="button"
              className="zorin-workspace__action"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Reload
            </button>
          )}
          <a className="zorin-workspace__action" href={url} target="_blank" rel="noopener noreferrer">
            Open in browser
          </a>
        </div>
      </header>
      {revealEndpoint && (
        <div className="zorin-workspace__endpoint" role="note">
          <code>{url}</code>
          <p className="muted-copy">
            Auth is server-side: caddy injects the bearer for <code>/api/widget/chat</code> from the same origin.
            Conversation history is kept in the embedded page's localStorage, not in the desktop state.
          </p>
        </div>
      )}
      <div className="zorin-workspace__frame-wrap">
        {surface === "native" ? (
          <ZorinNative />
        ) : (
          <iframe
            key={reloadKey}
            className="zorin-workspace__frame"
            src={url}
            title="Chat with Zorin"
            allow="clipboard-write"
          />
        )}
      </div>
    </section>
  );
}
