# ADR-020: Resonant Notes Clean-Room Workspace

Status: Accepted  
Date: 2026-04-27

## Decision

ResonantOS will build a **clean-room Obsidian-compatible notes workspace** as part of the Obsidian add-on path.

This workspace may reproduce public, user-visible knowledge-management behavior over Markdown vaults, but it must not copy, de-minify, translate, or derive implementation from Obsidian's proprietary application code.

The product name for the internal implementation is **Resonant Notes**. The Obsidian add-on remains the compatibility bridge for existing Obsidian vaults and external Obsidian handoff.

## Why

The user wants the benefit of Obsidian-style local knowledge work inside ResonantOS, with Augmentor able to operate over notes, links, tags, and vault context.

The correct long-term strategy is to own the code and behavior inside ResonantOS while preserving interoperability with existing Markdown vaults. That gives ResonantOS:

- full AI control through audited host commands
- cross-platform behavior
- clean security boundaries
- compatibility with normal folders and Obsidian vaults
- no hard dependency on the native Obsidian app

Obsidian's core app is not an open-source dependency for ResonantOS. Inspecting packaged proprietary code and rewriting it in another language is not allowed for this project because it risks derivative-work contamination.

## Rules

- Do not inspect or copy Obsidian's proprietary application source, de-minified bundles, private internals, UI assets, trademarks, or undocumented implementation details.
- Implement only from public behavior, open file formats, public documentation, and independent design.
- Use open standards and independently written parsers where possible:
  - Markdown/CommonMark-compatible syntax
  - YAML frontmatter
  - wikilinks such as `[[Note]]`
  - tags such as `#topic`
  - filesystem folder trees
  - deterministic link graph generation from vault files
- The workspace must work for both real Obsidian vaults and ordinary Markdown folders.
- External Obsidian remains optional and is accessed only through validated URI handoff.
- ResonantOS-owned note writes must remain host-mediated, audited, and stale-save protected.
- AI-suggested edits, tags, links, refactors, or reorganisations require explicit user approval before mutating vault files.
- Trusted Living Archive knowledge writes remain outside the Obsidian add-on. Notes may be queued only as raw intake unless promoted by the Strategist-owned archive ingest/review service.

## Interfaces Constrained

### Host Commands

The host owns vault indexing and file mutation.

Read/index commands:

- `obsidian_vault_status`
- `obsidian_list_notes`
- `obsidian_read_note`
- `obsidian_vault_index`

Write commands:

- `obsidian_write_note`
- future `obsidian_create_note`
- future `obsidian_rename_note`
- future `obsidian_apply_approved_patch`

### Vault Index

The first Resonant Notes index must expose:

- note title
- relative path
- modified marker
- size
- tags
- outgoing wikilinks
- backlinks
- deterministic search matches

The index is a working product feature and a future foundation for graph view, backlink panels, Augmentor actions, and Living Archive intake planning.

### UI Modules

The Obsidian-compatible workspace should grow as independent modules:

- `ObsidianWorkspace`
- `ObsidianVaultTree`
- `ObsidianEditor`
- `ObsidianPreview`
- `ObsidianMetadataPanel`
- future `ObsidianSearchPanel`
- future `ObsidianBacklinksPanel`
- future `ObsidianGraphPanel`

## Consequences

- ResonantOS can become a serious knowledge workspace without embedding the native Obsidian app.
- The user keeps full ownership of local Markdown files.
- Obsidian remains useful but optional.
- The implementation is legally cleaner and architecturally stronger than native-app embedding.
- Full Obsidian plugin compatibility is not promised.
- ResonantOS can later expose its own add-on APIs for note operations and AI-assisted knowledge work.

