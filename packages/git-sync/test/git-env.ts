/**
 * Isolates the real-git suites from the machine's git configuration. Import it
 * FIRST in every suite that runs git: the engine's `vaultGitEnv` and the
 * suites' own `execFile("git", ...)` calls all inherit `process.env`, so from
 * here on no git they start reads the global (~/.gitconfig) or system config.
 * An ambient `core.hooksPath` would otherwise silently disable the vault's
 * pre-receive guard, and `commit.gpgsign`, `init.defaultBranch` or an
 * attributes/filter setup would change what the suites observe.
 */
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
