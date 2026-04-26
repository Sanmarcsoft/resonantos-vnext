// Intent citation: docs/architecture/ADR-011-living-archive-host-service.md
// Intent citation: docs/architecture/ADR-013-living-archive-memory-domains.md

import { useState } from "react";
import type { ArchiveClassificationProposal, ArchiveLibraryClassificationReview } from "../../core/contracts";

type ArchiveClassificationReviewPanelProps = {
  review: ArchiveLibraryClassificationReview;
};

export function ArchiveClassificationReviewPanel({ review }: ArchiveClassificationReviewPanelProps) {
  const [intentApproved, setIntentApproved] = useState(false);
  const targetCounts = review.proposals.reduce<Record<string, number>>((counts, proposal) => {
    counts[proposal.proposedTarget] = (counts[proposal.proposedTarget] ?? 0) + 1;
    return counts;
  }, {});

  return (
    <section className="classification-review-surface" aria-label="Mixed library classification review">
      <div className="classification-review-head">
        <div>
          <span className="eyebrow">Classification review</span>
          <strong>{review.libraryName}</strong>
          <p>
            Review the first-pass ownership plan before any future reorganisation command can move files between memory domains.
          </p>
        </div>
        <button type="button" className="button-secondary touch-action" onClick={() => setIntentApproved(true)}>
          Approve Classification Intent
        </button>
      </div>
      <div className="classification-summary-strip" aria-label="Classification summary">
        <span>{review.recordsTotal} files in library</span>
        <span>{review.proposalsPreviewed} previewed</span>
        <span>{review.remainingForFullReview} waiting for full review</span>
        <span>{review.metadataStandard}</span>
        <span>{review.requiresHumanApprovalBeforeMove ? "human approval required" : "approval policy missing"}</span>
      </div>
      <div className="classification-summary-strip" aria-label="Classification target counts">
        <span>{targetCounts["human-knowledge"] ?? 0} Human Knowledge</span>
        <span>{targetCounts["external-knowledge"] ?? 0} External Knowledge</span>
        <span>{targetCounts.unclear ?? 0} unclear</span>
      </div>
      <div className="classification-review-grid">
        {review.proposals.map((proposal) => (
          <ClassificationProposalCard key={proposal.sourceId} proposal={proposal} />
        ))}
      </div>
      {review.remainingForFullReview ? (
        <div className="inline-notice">
          Showing the preview proposals from the host artifact. Bulk filtering and reclassification will stay host-mediated so the UI
          does not become the authority for memory ownership.
        </div>
      ) : null}
      <div className={`inline-notice ${intentApproved ? "" : "warning"}`}>
        {intentApproved
          ? "Classification intent approved. The next step is a separate host-mediated reorganisation plan with audit log and rollback."
          : "No files are moved by this screen. This approval records intent only; structural changes remain blocked here."}
      </div>
      <details className="archive-mini-details classification-path-details">
        <summary>Review artifact</summary>
        <p className="path-chip">{review.manifestPath}</p>
      </details>
    </section>
  );
}

function ClassificationProposalCard({ proposal }: { proposal: ArchiveClassificationProposal }) {
  return (
    <article className="classification-proposal-card">
      <div className="classification-proposal-main">
        <div>
          <strong>{proposal.title}</strong>
          <p>{proposal.reason}</p>
        </div>
        <span className={`tone ${proposal.proposedTarget === "unclear" ? "tone-warning" : "tone-active"}`}>
          {proposal.proposedTarget}
        </span>
      </div>
      <div className="classification-chip-row" aria-label="Classification signals">
        <span>confidence/{proposal.confidence}</span>
        {proposal.tags.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
        {proposal.wikilinks.map((link) => (
          <span key={link}>{link}</span>
        ))}
      </div>
      <details className="archive-mini-details classification-path-details">
        <summary>Source path</summary>
        <p className="path-chip">{proposal.canonicalPath}</p>
      </details>
    </article>
  );
}
