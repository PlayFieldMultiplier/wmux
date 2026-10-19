import type { ApprovalScreenReader } from '../../shared/approvalScreen';
import { resizeRevision } from '../notification/idleSuppression';

interface LocalPty { process: { cols: number; rows: number } }
interface WindowState { isDestroyed(): boolean }

/** The bridge separately fences input/output revisions and detector lifetime. */
export function createLocalApprovalScreenReader(deps: {
  getPty(id: string): LocalPty | undefined;
  getWindow(): WindowState | null;
  read(id: string): Promise<unknown>;
}): ApprovalScreenReader {
  return async (id) => {
    const pty = deps.getPty(id);
    const window = deps.getWindow();
    if (!pty || !window || window.isDestroyed()) return null;
    const { cols, rows } = pty.process;
    const resize = resizeRevision(id);
    if (cols <= 0 || rows <= 0) return null;
    const result = await deps.read(id).catch(() => null);
    if (!result || typeof result !== 'object') return null;
    const frame = result as Record<string, unknown>;
    if (frame.ptyId !== id || frame.approvalScreen !== true || frame.cols !== cols || frame.rowCount !== rows
      || !Array.isArray(frame.rows) || frame.rows.length !== rows || !frame.rows.every((row) => typeof row === 'string')) return null;
    const isCurrent = (): boolean => deps.getPty(id) === pty && deps.getWindow() === window && !window.isDestroyed()
      && pty.process.cols === cols && pty.process.rows === rows && resizeRevision(id) === resize;
    return isCurrent() ? { rows: frame.rows as string[], isCurrent } : null;
  };
}
