/**
 * Multiplexer module exports
 *
 * Pane lifecycle code (adapters, factory, client wiring) is client-side only:
 * the server entry must not import this barrel.
 */

export type { CmuxClient, CommandRunner } from './cmux';
export { CliCmuxClient, CmuxMultiplexer } from './cmux';
export {
  getMultiplexer,
  startAvailabilityCheck,
} from './factory';
export { HerdrMultiplexer } from './herdr';
export { KittyMultiplexer } from './kitty';
export { TmuxMultiplexer } from './tmux';
export type { Multiplexer, PaneResult } from './types';
export { ZellijMultiplexer } from './zellij';
