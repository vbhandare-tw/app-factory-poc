/**
 * Public entry point for the factory as a library.
 *
 * The pure domain layer, vault I/O and the config layer exist so far (plan
 * Phases 1–4). Runner, agents and the orchestrator are added by later phases.
 */
export * from './domain/roles.js';
export * from './domain/states.js';
export * from './domain/types.js';
export * from './domain/ids.js';
export * from './domain/guards.js';
export * from './domain/transitions.js';
export * from './domain/dag.js';
export * from './domain/schedule.js';

export * from './vault/atomic.js';
export * from './vault/note.js';
export * from './vault/paths.js';
export * from './vault/storage.js';
export * from './vault/index-md.js';

export * from './config/schema.js';
export * from './config/load.js';
export * from './config/registry.js';
export * from './config/resolve.js';
export * from './config/validate.js';
