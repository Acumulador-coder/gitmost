import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CLIENT_CONFIG_KEYS,
  buildDefineEnv,
} from "@/lib/client-config-keys.ts";

/**
 * The dev config plumbing, guarded by DERIVATION.
 *
 * In DEV there is no server-rendered `window.CONFIG`: `getConfigValue` reads
 * `process.env[key]`, and vite replaces `process.env` wholesale with the static
 * object `vite.config.ts` builds via `buildDefineEnv`. A key absent from that
 * object is unreachable in dev. This test derives the required key set from the
 * `getConfigValue("…")` call sites in `config.ts` and checks the list against
 * it; adding a `getConfigValue("NEW_KEY")` without listing NEW_KEY reds it.
 *
 * Under vitest `process.env` is the real Node object and vite's substitution
 * never runs, so reading `process.env.X` would pass vacuously; the test
 * exercises `buildDefineEnv`, the function the config actually calls.
 */

// The client vitest runs with apps/client as cwd.
const CLIENT_ROOT = process.cwd();

const CONFIG_SOURCE = readFileSync(
  path.resolve(CLIENT_ROOT, "src/lib/config.ts"),
  "utf8",
);
const VITE_CONFIG_SOURCE = readFileSync(
  path.resolve(CLIENT_ROOT, "vite.config.ts"),
  "utf8",
);

/** Every key the client can ask `getConfigValue` for — the single source. */
function deriveConfigKeys(source: string): string[] {
  const keys = new Set<string>();
  const callSite = /getConfigValue\(\s*["']([A-Z][A-Z0-9_]*)["']/g;
  for (const match of source.matchAll(callSite)) keys.add(match[1]);
  return [...keys].sort();
}

const DERIVED_KEYS = deriveConfigKeys(CONFIG_SOURCE);

describe("dev config reachability (#638 finding 1)", () => {
  it("derives a non-trivial key set from config.ts", () => {
    // Guards the derivation itself: a regex that silently matched nothing would
    // make the drift assertion below vacuously true.
    expect(DERIVED_KEYS.length).toBeGreaterThanOrEqual(10);
    expect(DERIVED_KEYS).toContain("APP_URL");
  });

  it("keeps getConfigValue module-private, so config.ts is the whole source", () => {
    // If it were exported, call sites outside config.ts could introduce keys the
    // derivation would never see, making this guard incomplete.
    expect(CONFIG_SOURCE).toContain("function getConfigValue(");
    expect(CONFIG_SOURCE).not.toContain("export function getConfigValue(");
  });

  it("makes EVERY key config.ts reads reachable in a dev build", () => {
    // A distinct sentinel per key: a key wired to the wrong source value fails
    // here too, not just a missing one.
    const env = Object.fromEntries(
      DERIVED_KEYS.map((key) => [key, `sentinel-${key}`]),
    );

    const devProcessEnv = buildDefineEnv(env);

    for (const key of DERIVED_KEYS) {
      expect(
        devProcessEnv[key],
        `${key} is readable via getConfigValue but is missing from CLIENT_CONFIG_KEYS, ` +
          `so it is baked into the dev bundle as undefined and unreachable in dev`,
      ).toBe(`sentinel-${key}`);
    }
  });

  it("keeps the define object generated from the single list", () => {
    // The generation is what makes the guard above meaningful: if vite.config
    // went back to hand-listing keys, CLIENT_CONFIG_KEYS could be correct while
    // the bundle still missed one.
    expect(VITE_CONFIG_SOURCE).toContain('"process.env": buildDefineEnv(env)');
  });

  it("does not leak non-allowlisted env into the browser bundle", () => {
    // `loadEnv(mode, dir, "")` returns the FULL server env, so the projection
    // must drop everything not on the list — otherwise secrets get inlined.
    const devProcessEnv = buildDefineEnv({
      APP_URL: "http://localhost:3000",
      DATABASE_URL: "postgres://user:pw@host/db",
      APP_SECRET: "super-secret",
    });

    expect(devProcessEnv.APP_URL).toBe("http://localhost:3000");
    expect(devProcessEnv).not.toHaveProperty("DATABASE_URL");
    expect(devProcessEnv).not.toHaveProperty("APP_SECRET");
    expect(Object.keys(devProcessEnv).sort()).toEqual([...CLIENT_CONFIG_KEYS].sort());
  });

  it("does not change any flag's default — reachable is not enabled", () => {
    // This change makes keys REACHABLE; it must not flip a default. The defaults
    // live in the `getConfigValue` call sites, untouched here, so an
    // unconfigured deploy (dev or prod) still reads exactly what it read before.
    expect(CONFIG_SOURCE).toContain(
      'getConfigValue("DRAWIO_RASTER_ENABLED", "false")',
    );
    expect(CONFIG_SOURCE).toContain(
      'getConfigValue("EXCALIDRAW_RASTER_ENABLED", "false")',
    );
    expect(CONFIG_SOURCE).toContain('getConfigValue("OFFLINE_GRACE", "30d")');
  });
});
