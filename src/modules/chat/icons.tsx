// Intent citation: docs/architecture/ADR-004-chat-rail.md
// Icon source citation: public/icons/third-party/tabler/LICENSE

type TablerIconName =
  | "archive"
  | "arrow-right"
  | "chart-bar"
  | "copy"
  | "dots"
  | "eye"
  | "git-branch"
  | "history"
  | "microphone"
  | "pencil"
  | "pin"
  | "plus"
  | "refresh"
  | "trash";

function TablerIcon({ name }: { name: TablerIconName }) {
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
      <use href={`/icons/vendor-ui.svg#tabler-${name}`} />
    </svg>
  );
}

export function PlusIcon() {
  return <TablerIcon name="plus" />;
}

export function MicIcon() {
  return <TablerIcon name="microphone" />;
}

export function SendIcon() {
  return <TablerIcon name="arrow-right" />;
}

export function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="8" width="8" height="8" rx="1.8" fill="currentColor" />
    </svg>
  );
}

export function CopyIcon() {
  return <TablerIcon name="copy" />;
}

export function ArchiveIcon() {
  return <TablerIcon name="archive" />;
}

export function BranchIcon() {
  return <TablerIcon name="git-branch" />;
}

export function RegenerateIcon() {
  return <TablerIcon name="refresh" />;
}

export function TrashIcon() {
  return <TablerIcon name="trash" />;
}

export function EditIcon() {
  return <TablerIcon name="pencil" />;
}

export function StatsIcon() {
  return <TablerIcon name="chart-bar" />;
}

export function HideIcon() {
  return <TablerIcon name="eye" />;
}

export function HistoryIcon() {
  return <TablerIcon name="history" />;
}

export function PinIcon() {
  return <TablerIcon name="pin" />;
}

export function MoreIcon() {
  return <TablerIcon name="dots" />;
}
