import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ResolvedSource {
  /** Exact argument passed to `git clone`; may contain caller-supplied credentials. */
  clone: string;
  /** Source safe to persist and display: URL userinfo secrets, query and fragment removed. */
  stored: string;
  /** Equivalence key used to reuse existing clones. Never contains credentials. */
  key: string;
}

const SCHEME_URL = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
// GitHub owners start with an alphanumeric character, so `./repo` and
// `../repo` stay local relative paths instead of becoming GitHub URLs.
const GITHUB_SHORTHAND = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+)$/;
const SCP_LIKE = /^(?:([^/@:]+)@)?([^/:]{2,}):(?!\/\/)(.*)$/;
const SSH_SCHEMES = new Set(["ssh:", "git+ssh:", "ssh+git:"]);
/**
 * URL schemes Git handles natively. Any other `<scheme>://` source, like every
 * `<helper>::<address>` source, makes Git run a `git-remote-<name>` program
 * chosen by the caller, so both are rejected.
 */
const SUPPORTED_SCHEMES = new Set(["http:", "https:", "ftp:", "ftps:", "git:", "file:", ...SSH_SCHEMES]);
// Git's remote-helper syntax; same character rules as Git's `is_urlschemechar`.
const REMOTE_HELPER = /^([A-Za-z][A-Za-z0-9+.-]*)::/;
const UNSUPPORTED_SOURCE = "Unsupported repository source: use an HTTPS, SSH, Git or file URL, `host:path`, a local path, or GitHub `owner/repo`.";
/** Longest accepted source; bounds all parsing work on caller input. */
export const MAX_SOURCE_LENGTH = 4096;

export function parseGitHubShorthand(source: string): { owner: string; repo: string } | undefined {
  const match = source.match(GITHUB_SHORTHAND);
  if (!match) return undefined;
  const repo = match[2]!.replace(/\.git$/i, "");
  if (!repo || repo === "." || repo === "..") return undefined;
  return { owner: match[1]!, repo };
}

/**
 * Resolve a caller-supplied source to the clone argument, a credential-free
 * persisted form and an equivalence key. Equivalent spellings share a key:
 * `owner/repo`, `https://GitHub.com/owner/repo.git/`, scheme/host case,
 * trailing `.git` or slash on remote URLs, and `file://` vs. local paths.
 * Remote-helper (`<helper>::<address>`) and unknown-scheme sources are rejected.
 */
export function resolveSource(raw: string, cwd: string): ResolvedSource {
  if (raw.length > MAX_SOURCE_LENGTH) throw new Error(`Repository source exceeds ${MAX_SOURCE_LENGTH} characters.`);
  const source = raw.trim();
  if (!source) throw new Error("Repository source is required.");

  const shorthand = parseGitHubShorthand(source);
  if (shorthand) {
    const url = `https://github.com/${shorthand.owner}/${shorthand.repo}.git`;
    return { clone: url, stored: url, key: urlKey(new URL(url)) };
  }

  if (SCHEME_URL.test(source)) {
    let url: URL;
    try { url = new URL(source); }
    catch { throw new Error("Repository source is not a valid URL."); }
    if (!SUPPORTED_SCHEMES.has(url.protocol)) throw new Error(UNSUPPORTED_SOURCE);
    if (url.protocol === "file:") {
      const path = fileUrlPath(source);
      return { clone: source, stored: pathToFileURL(path).href, key: `path:${path}` };
    }
    const stored = redactUrl(url);
    return { clone: source, stored, key: urlKey(url) };
  }

  // Git's `<transport>::<address>` remote helpers run arbitrary programs.
  if (REMOTE_HELPER.test(source)) throw new Error(UNSUPPORTED_SOURCE);

  const scp = source.match(SCP_LIKE);
  if (scp && !isAbsolute(source)) {
    const [, user, host, path] = scp;
    const normalizedPath = stripGitSuffix(path!);
    return { clone: source, stored: source, key: `scp:${user ? `${user}@` : ""}${host!.toLowerCase()}:${normalizedPath}` };
  }

  const path = stripTrailingSeparators(resolve(cwd, source));
  return { clone: path, stored: path, key: `path:${path}` };
}

/**
 * Remove credentials from a persisted source written by an earlier version,
 * including the address inside a `<helper>::<address>` source.
 */
export function redactStoredSource(source: string): string {
  const helper = source.match(REMOTE_HELPER);
  if (helper) return `${helper[0]}${redactStoredUrl(source.slice(helper[0].length))}`;
  return redactStoredUrl(source);
}

function redactStoredUrl(source: string): string {
  if (!SCHEME_URL.test(source)) return source;
  try {
    const url = new URL(source);
    // Earlier builds stored `file://<path>` unescaped; re-encode it.
    return url.protocol === "file:" ? pathToFileURL(fileUrlPath(source)).href : redactUrl(url);
  } catch {
    return source;
  }
}

/** Equivalence key for a persisted record, or undefined when it cannot be derived. */
export function storedSourceKey(source: string): string | undefined {
  try { return resolveSource(source, "/").key; }
  catch { return undefined; }
}

/** True when the clone URL carries data that must not stay in the clone's Git config. */
export function hasSecretUrlParts(source: string): boolean {
  if (!SCHEME_URL.test(source)) return false;
  try {
    const url = new URL(source);
    if (url.protocol === "file:") return false;
    return Boolean(url.password || url.search || url.hash || (url.username && !SSH_SCHEMES.has(url.protocol)));
  } catch {
    return false;
  }
}

/**
 * Validate a branch or tag name for `git clone --branch`. Follows
 * git-check-ref-format rules and rejects a leading `-` so the value can never
 * be read as an option.
 */
export function validateRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ref = value.trim();
  if (!ref) return undefined;
  const invalid = ref.length > 255
    || ref.startsWith("-")
    || ref.startsWith("/")
    || ref.endsWith("/")
    || ref.endsWith(".")
    || ref.endsWith(".lock")
    || ref === "@"
    || ref.includes("..")
    || ref.includes("//")
    || ref.includes("@{")
    || ref.split("/").some((part) => part.startsWith("."))
    // Control characters, space and characters Git forbids in ref names.
    || /[\u0000- \u007f~^:?*[\\]/.test(ref);
  if (invalid) throw new Error("Invalid branch or tag name.");
  return ref;
}

/**
 * Local path of a `file:` URL as Git reads it: `#` and `?` are literal path
 * characters, not a fragment or query, and `%XX` escapes are decoded.
 */
export function fileUrlPath(source: string): string {
  const literal = source.replace(/[#?]/g, (char) => (char === "#" ? "%23" : "%3F"));
  return stripTrailingSeparators(fileURLToPath(new URL(literal)));
}

function redactUrl(url: URL): string {
  const user = SSH_SCHEMES.has(url.protocol) && url.username ? `${url.username}@` : "";
  const port = url.port ? `:${url.port}` : "";
  return `${url.protocol}//${user}${url.hostname}${port}${url.pathname === "/" ? "" : url.pathname}`;
}

function urlKey(url: URL): string {
  const protocol = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  const user = SSH_SCHEMES.has(protocol) && url.username ? `${url.username}@` : "";
  const port = url.port ? `:${url.port}` : "";
  let path = stripGitSuffix(url.pathname);
  // GitHub owner and repository names are case-insensitive.
  if (host === "github.com" || host === "www.github.com") path = path.toLowerCase();
  return `${protocol}//${user}${host === "www.github.com" ? "github.com" : host}${port}${path}`;
}

function stripGitSuffix(path: string): string {
  return stripTrailingSeparators(stripTrailingSeparators(path).replace(/\.git$/i, ""));
}

function stripTrailingSeparators(path: string): string {
  const stripped = trimTrailing(path, "/\\");
  return stripped || path.slice(0, 1);
}

/**
 * Remove trailing characters found in `chars`. A loop instead of a `[...]+$`
 * regex, which backtracks quadratically on long runs of those characters.
 */
export function trimTrailing(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1]!)) end--;
  return value.slice(0, end);
}

/** Remove leading characters found in `chars`. */
export function trimLeading(value: string, chars: string): string {
  let start = 0;
  while (start < value.length && chars.includes(value[start]!)) start++;
  return value.slice(start);
}
