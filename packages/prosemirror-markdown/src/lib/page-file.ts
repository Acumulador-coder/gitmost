/**
 * The native-Obsidian page-file format (design: docs/backlog/git-sync-thin-meta.md).
 * A page file is CLEAN markdown with a minimal YAML frontmatter carrying ONLY the
 * page's durable identity:
 *
 *   ---
 *   gitmost_id: 019ef6fc-2638-7ce1-9ce3-2756ce038480
 *   ---
 *   <clean markdown body>
 *
 * Everything else is derived (title = filename, parentPageId = enclosing folder,
 * spaceId = the vault, updatedAt = git). `gitmost_id` (a Docmost pageId) is the
 * only non-derivable bit and travels WITH the file so identity survives any move,
 * even one git's rename detection misses. Third-party editors (Obsidian, …) see
 * clean markdown; the frontmatter is hidden in their preview.
 *
 * The `docmost:meta` format is not read here: vaults are a cache, rebuilt in
 * this format. A file WITHOUT a `gitmost_id` frontmatter is an un-tracked
 * (e.g. hand-written) file -> the caller ADOPTS it (creates a page, writes the id).
 */

/**
 * The frontmatter key carrying the Docmost pageId. NAMESPACED (not a bare `id`)
 * so it never collides with a user's own frontmatter fields.
 */
export const ID_KEY = "gitmost_id";

/** Leading YAML frontmatter block: `---\n…\n---` at the very start of the file. */
const FRONTMATTER_RE = /^﻿?---\n([\s\S]*?)\n---\n?/;

/**
 * The top-level `<ID_KEY>: <value>` line inside the frontmatter (quotes optional).
 *
 * Parsed by prefix + trim, never by a backtracking regex: the former
 * `^gitmost_id:\s*(.+?)\s*$` took quadratic time on a long whitespace run inside
 * the value (a 40k-space line blocked the event loop for most of a second, and
 * every tracked file is parsed on every sync cycle). The result is the same as
 * that regex's: a line counts only when its value holds a character a regex `.`
 * matches, and that value may not span a line terminator (`\r`, U+2028,
 * U+2029); a whitespace-only value reads as no id.
 */
function readIdFromYaml(yaml: string): string | null {
  const prefix = `${ID_KEY}:`;
  for (const line of yaml.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    if (/^[\r\u2028\u2029]*$/.test(rest)) continue;
    const value = rest.trim();
    if (/[\r\u2028\u2029]/.test(value)) continue;
    const v = value.replace(/^["']|["']$/g, "");
    return v === "" ? null : v;
  }
  return null;
}

/**
 * Parse a page file into its identity (`id`) and clean markdown `body`. Tolerant:
 * a file with no frontmatter (a hand-written third-party file) returns `id: null`
 * and the whole text as the body — the caller then ADOPTS it (creates a page,
 * writes the id back).
 *
 * KNOWN LIMITATION (see docs/backlog/git-sync-thin-meta.md): a leading
 * frontmatter block is stripped from `body` even when it carries NO `gitmost_id`
 * but DOES carry the user's own Obsidian properties (`tags:` etc.), and
 * `serializePageFile` persists only `gitmost_id` — so do NOT use this format on a
 * real Obsidian vault whose notes carry properties.
 */
export function parsePageFile(full: string): {
  id: string | null;
  body: string;
} {
  const text = (full ?? "").replace(/\r\n/g, "\n");

  // Native format: a `gitmost_id` YAML frontmatter. Anything else (no frontmatter,
  // or frontmatter without the key) is an un-tracked file -> adopt.
  const fm = text.match(FRONTMATTER_RE);
  if (fm) {
    return { id: readIdFromYaml(fm[1]), body: text.slice(fm[0].length).trim() };
  }
  return { id: null, body: text.trim() };
}

/**
 * Serialize a page into the thin format: `id` frontmatter + a blank line + the
 * clean body + a trailing newline. Deterministic so an unchanged page re-syncs to
 * byte-identical output (no churn — the loop-guard relies on it).
 */
export function serializePageFile(id: string, body: string): string {
  return `---\n${ID_KEY}: ${id}\n---\n\n${body.trim()}\n`;
}
