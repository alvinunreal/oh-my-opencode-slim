// Compatibility shim for local deep imports; keep only the stable runtime
// surface here. `applyPreparedChanges()` remains in operations.ts as an
// internal best-effort helper for local tests/helpers.
export { parsePatch } from './codec';
export {
  preparePatchChanges,
  rewritePatch,
  rewritePatchText,
} from './operations';
