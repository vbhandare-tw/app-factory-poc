/**
 * Public entry point for the factory as a library.
 *
 * Only the pure domain layer exists so far (plan Phases 1–2). Vault I/O,
 * config, runner, agents and the orchestrator are added by later phases.
 */
export * from './domain/roles.js';
export * from './domain/states.js';
export * from './domain/types.js';
export * from './domain/ids.js';
export * from './domain/guards.js';
export * from './domain/transitions.js';
export * from './domain/dag.js';
export * from './domain/schedule.js';
