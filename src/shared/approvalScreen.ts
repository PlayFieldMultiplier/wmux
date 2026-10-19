/** A parsed live viewport, never an ANSI-stripped byte log or scrollback. */
export interface ApprovalScreenSnapshot {
  rows: readonly string[];
  /** Pane lifetime, output mark and geometry still match the captured grid. */
  isCurrent: () => boolean;
}

/** Resolve only after the terminal parser has applied all preceding output. */
export type ApprovalScreenReader = (ptyId: string) => Promise<ApprovalScreenSnapshot | null>;
