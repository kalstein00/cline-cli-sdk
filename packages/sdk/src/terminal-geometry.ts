export interface TerminalSize { rows: number; cols: number }

export const DEFAULT_TERMINAL: TerminalSize = {rows:40,cols:120};

/** Bounds shared with recording validation and direct tmux observations. */
export function validTerminalSize(value: unknown): value is TerminalSize {
  const size=value as TerminalSize | undefined;
  return !!size && Number.isInteger(size.cols) && size.cols>=20 && size.cols<=500 &&
    Number.isInteger(size.rows) && size.rows>=5 && size.rows<=200;
}

export function sameTerminalSize(a: TerminalSize | undefined, b: TerminalSize | undefined): boolean {
  return !!a && !!b && a.cols===b.cols && a.rows===b.rows;
}

/** UTF-8 bytes conservatively bound printable cell width; reserve prompt and edge space. */
export function composerMaxBytes(cols: number): number {
  return Math.max(0,Math.min(112,cols-8));
}
