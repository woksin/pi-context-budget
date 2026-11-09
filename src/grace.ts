import { lstatSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative } from "node:path";

/** Resolve existing components before '..'; retain missing suffixes for new state files. */
function canonicalPath(path: string, cwd: string): string {
  let current = isAbsolute(path) ? "/" : cwd;
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { current = dirname(current); continue; }
    const next = join(current, part);
    try { current = realpathSync.native(next); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink is not a missing regular file: its target is unknown.
      try { if (lstatSync(next).isSymbolicLink()) throw new Error("Unresolved symlink"); }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError; }
      current = next;
    }
  }
  return current;
}

const GIT_OPTIONS: Record<string, RegExp> = {
  status: /^(?:--short|-s|--branch|-b|--porcelain(?:=v[12])?|--untracked-files(?:=(?:no|normal|all))?)$/,
  diff: /^(?:--stat|--name-only|--name-status|--shortstat|--numstat|--cached|--staged|--no-ext-diff|--no-textconv|--no-color|--check|--quiet|--exit-code|--relative)$/,
  log: /^(?:--oneline|--stat|--name-only|--name-status|--no-decorate|--decorate|--all|--graph|--no-color|--no-ext-diff|--no-textconv|--max-count=\d+|-\d+|--format=[A-Za-z0-9%:.,_-]+)$/,
  "rev-parse": /^(?:--show-toplevel|--show-prefix|--show-cdup|--git-dir|--absolute-git-dir|--is-inside-work-tree|--abbrev-ref|--verify|--short(?:=\d+)?)$/,
};
function readOnlyGit(command: string): boolean {
  // No shell syntax, quoting, expansions, control characters or global git options.
  if (!/^[A-Za-z0-9_./:@%+=, \t-]+$/.test(command)) return false;
  const [git, subcommand, ...args] = command.trim().split(/[ \t]+/);
  if (git !== "git") return false;
  if (subcommand === "branch") return args.length === 1 && args[0] === "--show-current";
  const options = GIT_OPTIONS[subcommand ?? ""];
  if (!options) return false;
  let paths = false;
  return args.every(arg => {
    if (arg === "--") { paths = true; return true; }
    if (paths || !arg.startsWith("-")) return subcommand !== "status" || paths;
    return options.test(arg);
  });
}

/** Fail-closed classification; only state paths and a small read-only git vocabulary. */
export function graceEligible(tool: string, input: unknown, cwd: string): boolean {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const value = input as Record<string, unknown>;
    if (tool === "bash") return typeof value.command === "string" && readOnlyGit(value.command);
    if (!["read", "edit", "write"].includes(tool)) return false;
    const path = value.path ?? value.file_path;
    if (typeof path !== "string" || !path || path.includes("\0")) return false;
    const base = canonicalPath(cwd, "/"), target = canonicalPath(path, base);
    // Ignore any ai-work ancestor of cwd (e.g. a worktree or test fixture stored there).
    const statePath = relative(base, target).split("/").includes(".ai-work");
    return statePath && (tool === "read" || extname(target) === ".md");
  } catch { return false; }
}
