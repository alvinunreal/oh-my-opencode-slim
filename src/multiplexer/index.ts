/**
 * Multiplexer module exports
 */

export type { CmuxClient, CommandRunner } from './cmux';
export { CliCmuxClient, CmuxMultiplexer } from './cmux';
export {
  getMultiplexer,
  startAvailabilityCheck,
} from './factory';
export { HerdrMultiplexer } from './herdr';
export {
  MultiplexerSessionManager,
  TmuxSessionManager,
} from './session-manager';
export { TmuxMultiplexer } from './tmux';
export type { Multiplexer, PaneResult } from './types';
export { isServerRunning } from './types';
export { ZellijMultiplexer } from './zellij';
