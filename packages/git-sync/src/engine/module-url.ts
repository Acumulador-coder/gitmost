/**
 * The URL of this module, i.e. of the engine directory of the ESM build (see
 * `workerEntry` in ./convert-pool.ts). A module of its own because
 * `import.meta` is a syntax error in the CommonJS form jest loads the package
 * sources in; only the ESM build ever imports it.
 */
export const moduleUrl: string = import.meta.url;
