/**
 * Engine settings.
 *
 * The engine is driven IN-PROCESS by the NestJS server, which builds the
 * `Settings` object from `EnvironmentService`. This module therefore exposes
 * ONLY the `Settings` type the engine consumes — there is no `.env`-loading
 * side-effecting entry point and no env-validation here (the server owns that).
 */

export type Settings = {
  docmostSpaceId: string;
  vaultPath: string;
  pollIntervalMs: number;
  debounceMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
};
