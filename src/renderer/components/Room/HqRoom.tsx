// Compatibility shim: the HQ room left with the room dock (owner decision
// 2026-10-14). `latestThreadOf` lives in roomFormat; this re-export stays
// only until Bots/useBots imports it from there, then this file goes.
export { latestThreadOf } from './roomFormat';
