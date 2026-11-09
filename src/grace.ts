import { accessSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Pi 1.2's resolveToCwd is not a public export. Mirror its normalization before
// resolving symlinks; test against the runtime's resolver to catch drift.
function normalizePath(path: string, toolInput = false): string {
  let value = toolInput ? path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "") : path;
  if (process.platform === "win32" && !value.includes("\\")) {
    const drive = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (drive) value = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) return join(homedir(), value.slice(2));
  return value.startsWith("file://") ? fileURLToPath(value) : value;
}
export function resolveToolPath(path: string, cwd: string): string {
  return resolve(normalizePath(cwd), normalizePath(path, true));
}
function accessible(path: string): boolean {
  try { accessSync(path); return true; } catch { return false; }
}
function readPath(path: string): string {
  // Pi read also tries screenshot/Unicode variants when its primary path is absent.
  const nfd = path.normalize("NFD");
  const variants = [path, path.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, path.replace(/'/g, "\u2019"), nfd.replace(/'/g, "\u2019")];
  return variants.find(accessible) ?? path;
}
/** Realpath the longest existing prefix; reject unresolved/dangling symlinks. */
function canonicalPath(path: string): string {
  try { return realpathSync.native(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("Unresolved symlink"); }
    catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError; }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalPath(parent), basename(path));
  }
}

const GIT_OPTIONS: Record<string, RegExp> = {
  status: /^(?:--short|-s|--branch|-b|--porcelain(?:=v[12])?|--untracked-files(?:=(?:no|normal|all))?)$/,
  diff: /^(?:--stat|--name-only|--name-status|--shortstat|--numstat|--cached|--staged|--no-ext-diff|--no-textconv|--no-color|--check|--quiet|--exit-code|--relative)$/,
  log: /^(?:--oneline|--no-show-signature|--no-decorate|--decorate|--all|--graph|--no-color|--max-count=\d+|-\d+)$/,
  "rev-parse": /^(?:--show-toplevel|--show-prefix|--show-cdup|--git-dir|--absolute-git-dir|--is-inside-work-tree|--abbrev-ref|--verify|--short(?:=\d+)?)$/,
};
function safeGitOutput(subcommand: string, args: string[]): boolean {
  const separator = args.indexOf("--"), options = separator < 0 ? args : args.slice(0, separator);
  if (subcommand === "diff") return options.includes("--no-ext-diff") && options.includes("--no-textconv");
  // Fixed non-patch formatting also avoids configured pretty formats/signature helpers.
  if (subcommand === "log") return options.includes("--oneline") && options.includes("--no-show-signature");
  return true;
}
function readOnlyGit(command: string): boolean {
  // No shell syntax, quoting, expansions, control characters or global git options.
  // Git's default pager is disabled on the tool's non-TTY stdout; -p/--paginate cannot pass.
  if (!/^[A-Za-z0-9_./:@%+=, \t-]+$/.test(command)) return false;
  const [git, subcommand, ...args] = command.trim().split(/[ \t]+/);
  if (git !== "git") return false;
  if (subcommand === "branch") return args.length === 1 && args[0] === "--show-current";
  if (subcommand === "worktree") return args[0] === "list" && args.slice(1).every(arg => ["--porcelain", "--verbose", "-v"].includes(arg));
  const options = GIT_OPTIONS[subcommand ?? ""];
  if (!options || !safeGitOutput(subcommand, args)) return false;
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
    const resolved = resolveToolPath(path, cwd);
    const base = canonicalPath(resolve(normalizePath(cwd))), target = canonicalPath(tool === "read" ? readPath(resolved) : resolved);
    // Ignore any ai-work ancestor of cwd (e.g. a worktree or test fixture stored there).
    const statePath = relative(base, target).split("/").includes(".ai-work");
    return statePath && (tool === "read" || extname(target) === ".md");
  } catch { return false; }
}
