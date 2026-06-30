// @skillforge/core/capability — humble command/signature detector + bundle classification (D14).
//
// This is an INVENTORY of what we NOTICED in a skill's files, NOT a safety verdict.
// It never says "safe" / "verified" / "trusted". The UI repeats that disclaimer before
// any enable/exec action. The detector is HEURISTIC and HUMBLE: it scans for textual
// patterns only, makes NO claim about intent or safety, and can BOTH miss real behavior
// (obfuscated/encoded/late-bound code) AND over-flag benign text (a URL in prose,
// `string.format(...)`, a regex literal after `>`). Treat the output as "here is what we
// spotted, look for yourself" — nothing more. (Flag detection scans the FULL file content,
// not the truncated preview, so it does not miss dangerous lines merely for being long — D14.)
//
// Pure functions: callers pass already-read bytes/strings. We never touch the filesystem
// or spawn anything here.

import {
  type BundleEntry,
  type BundleKind,
  type CapabilityFlag,
  type SkillCapabilities,
} from "@skillforge/contracts";
// Import sha256 from its module directly, NOT the @skillforge/core barrel: the barrel
// re-exports this file, so the barrel path would form an import cycle (capability -> core
// -> capability). hash.ts has no cycle back to here.
import { sha256 } from "./hash.ts";

// Files that ARE scripts by extension (a shebang also promotes any file to a script).
// `cjs` is included so a CommonJS module classifies as a script and lines up with its
// EXT_INTERPRETER entry below (a `.cjs` file IS a script — D14).
const SCRIPT_EXTS = new Set(["sh", "bash", "zsh", "py", "js", "mjs", "cjs", "ts", "rb", "pl", "ps1"]);
// Files we treat as human-readable references.
const REFERENCE_EXTS = new Set(["md", "markdown", "txt", "rst"]);

// Best-effort interpreter inferred from a script extension (overridden by a shebang).
const EXT_INTERPRETER: Record<string, string> = {
  sh: "sh",
  bash: "bash",
  zsh: "zsh",
  py: "python",
  js: "node",
  mjs: "node",
  cjs: "node",
  ts: "node",
  rb: "ruby",
  pl: "perl",
  ps1: "powershell",
};

// ── capability signatures ─────────────────────────────────────────────────────
// Case-SENSITIVE on purpose: e.g. JS `Function(` is a capability, but `function(` (a
// declaration) is not, and shell tools (curl/rm/pip/...) are conventionally lowercase.
// Each entry maps a CapabilityFlag to a textual pattern we merely *noticed*.
const FLAG_SIGNATURES: ReadonlyArray<readonly [CapabilityFlag, RegExp]> = [
  // talks to the network
  ["network", /\bcurl\b|\bwget\b|\bnc\b|\bncat\b|\btelnet\b|https?:\/\/|\bfetch\s*\(|requests\.(?:get|post|put|delete|patch|head|request)\b|\burllib\b|\.urlopen\b/],
  // download tool whose output is piped straight into a shell (curl ... | sh)
  ["pipe-to-shell", /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/],
  // irreversible filesystem / device destruction
  ["destructive", /\brm\s+-\w*r\w*f\w*\b|\brm\s+-\w*f\w*r\w*\b|\bmkfs\b|\bdd\s+if=|\bshred\b|>\s*\/dev\/sd|(?<![.\w])format\s+[A-Za-z]:/],
  // dynamic code / process execution
  ["eval", /\beval\s*[("'`$]|\bexec\s*\(|\bFunction\s*\(|\bchild_process\b|\bos\.system\s*\(|\bsubprocess\b/],
  // package/tool installation
  ["install", /\bnpm\s+(?:i|install|add|ci)\b|\b(?:pnpm|yarn)\s+(?:i|install|add)\b|\b(?:pip|pip3|pipx)\s+install\b|\bapt(?:-get)?\s+install\b|\bbrew\s+install\b|\bcargo\s+install\b|\bgo\s+install\b|\bgem\s+install\b/],
  // writes files (shell redirection to a path, or library write calls)
  ["fs-write", /(?:^|[^>=\d\w])>>?\s*['"]?(?:(?:\.{0,2}\/|~\/|\/|[A-Za-z]:[\\/])[\w./\\${}~+-]+|[\w.${}~+-]+\.[A-Za-z]\w*)|\bfs\.write\w*\s*\(|\bopen\s*\([^)]*,\s*['"][wax]\+?[btr]*['"]|\.write_text\s*\(|\.write_bytes\s*\(/],

  // ── Windows/PowerShell + extra runtime network/install APIs (added per gate review B4) ──
  // The owner runs Windows 11, yet `.ps1` files classify as scripts (interpreter "powershell")
  // while ZERO PowerShell patterns existed above — a real blind spot. These entries close it.
  // PowerShell cmdlets are case-INSENSITIVE in the language and conventionally PascalCase, so
  // these alternatives are matched case-insensitively via a separate `i`-flagged entry. This
  // deliberately does NOT touch the case-SENSITIVE entries above (e.g. JS `Function(` must stay
  // distinct from a lowercase `function(` declaration; shell tools stay lowercase). Still a
  // HUMBLE inventory: the short aliases `iwr`/`irm` may both miss real calls and over-flag.
  // network: PowerShell web cmdlets + their aliases (Invoke-RestMethod => `irm`) + BITS transfer.
  ["network", /\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\biwr\b|\birm\b|\bStart-BitsTransfer\b/i],
  // network: Node http(s)/net client APIs and Python's socket module. Case-SENSITIVE — these
  // are lowercase library identifiers, not natural prose. The Python socket connect is anchored
  // to its idiomatic tuple form `.connect((host, port))` so we do not flag every db/client
  // `.connect(` as network (humble: this also means a socket connect via a variable is missed).
  ["network", /\bhttps?\.request\s*\(|\bnet\.(?:connect|createConnection)\s*\(|\bimport\s+socket\b|\bsocket\.socket\s*\(|\.connect\s*\(\s*\(/],
  // destructive: PowerShell Remove-Item (and the `ri`/`rd` aliases) ONLY when carrying a
  // -Recurse/-Force switch — mirroring how `rm -rf` needs its flags. A bare `Remove-Item file`
  // is NOT flagged and so is NOT listed as a command, keeping the inventory consistent (D14).
  // PowerShell resolves unique-PREFIX abbreviations (`-Re`, `-Fo`, `-Rec`, `-For`, in any order),
  // so matching only the full `-Recurse`/`-Force` was evadable (`Remove-Item -Re -Fo …`). We match
  // `-Re\w*`/`-Fo\w*`. The `(?<!-)` before the `ri`/`rd` aliases is load-bearing: without it `\bri\b`
  // fires on the `ri` inside a Unix `-ri` flag (the `-`→`r` word boundary), so `grep -ri -Fo needle`
  // would false-flag destructive. The lookbehind matches `ri`/`rd` only as standalone alias commands,
  // never as a flag char. Clear-Disk/Format-Volume are wipes outright.
  ["destructive", /\b(?:Remove-Item|(?<!-)ri|(?<!-)rd)\b[^\n]*-(?:Re\w*|Fo\w*)\b|\bClear-Disk\b|\bFormat-Volume\b/i],
  // install: Windows package managers + PowerShell module/package installers (case-insensitive).
  ["install", /\bwinget\s+install\b|\bchoco\s+install\b|\bInstall-Module\b|\bInstall-Package\b/i],
];

// Stable presentation order for flags (independent of detection order).
const FLAG_ORDER: readonly CapabilityFlag[] = ["network", "pipe-to-shell", "destructive", "eval", "install", "fs-write"];

// Leading tokens that look like a command but almost never are one (language keywords +
// a few extremely common identifiers) — dropped so the `commands` inventory stays readable.
const NON_COMMAND = new Set([
  "const", "let", "var", "function", "return", "if", "else", "elif", "for", "while", "do",
  "switch", "case", "import", "export", "from", "await", "async", "new", "class", "def",
  "try", "except", "finally", "with", "as", "in", "is", "not", "and", "or", "then", "fi",
  "done", "print", "data", "result", "results", "response", "resp", "res", "out", "output",
  "content", "text", "val", "value", "item", "self", "this", "url", "tmp", "temp",
]);

// ── small helpers ─────────────────────────────────────────────────────────────
function baseName(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const i = normalized.lastIndexOf("/");
  return i >= 0 ? normalized.slice(i + 1) : normalized;
}

/** Returns the flags whose signature appears anywhere in `text` (humble: pattern only). */
function flagsInText(text: string): CapabilityFlag[] {
  const out: CapabilityFlag[] = [];
  for (const [flag, re] of FLAG_SIGNATURES) if (re.test(text)) out.push(flag);
  return out;
}

/** True if a single line carries any capability signature. */
function lineHasSignature(line: string): boolean {
  return FLAG_SIGNATURES.some(([, re]) => re.test(line));
}

/** Best-effort leading command name of a line (after stripping `sudo` / `VAR=val` prefixes). */
function leadingCommand(line: string): string | undefined {
  const stripped = line.replace(/^\s*(?:sudo\s+)?(?:[A-Za-z_]\w*=\S+\s+)*/, "");
  const m = /^([A-Za-z_][\w.-]*)/.exec(stripped);
  if (!m) return undefined;
  let tok = baseName(m[1] ?? "").toLowerCase();
  // trim a trailing version-ish suffix is intentionally NOT done — `pip3` stays `pip3`.
  if (!/^[a-z][a-z0-9_.-]*$/.test(tok)) return undefined;
  if (NON_COMMAND.has(tok)) return undefined;
  return tok;
}

/**
 * First-token of every "detected command line" (a non-comment line that carries a
 * signature), unique + sorted. Best-effort and humble — see file header.
 */
function declaredCommands(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue; // skip blank lines, comments, shebangs
    if (!lineHasSignature(line)) continue;
    const cmd = leadingCommand(line);
    if (cmd) out.add(cmd);
  }
  return [...out].sort();
}

/** Interpreter inferred from a `#!` line; undefined when there is no shebang. */
function interpreterFromShebang(shebang: string | undefined): string | undefined {
  if (!shebang) return undefined;
  const rest = shebang.replace(/^#!\s*/, "").trim();
  if (!rest) return undefined;
  const parts = rest.split(/\s+/);
  const firstBase = baseName(parts[0] ?? "");
  if (firstBase === "env") {
    // `#!/usr/bin/env python3` (skip env flags like -S and inline VAR=val assignments)
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i] ?? "";
      if (p.startsWith("-") || /^[A-Za-z_]\w*=/.test(p)) continue;
      return baseName(p);
    }
    return "env";
  }
  return firstBase || undefined;
}

/** First ~200 chars, whitespace-collapsed, for a glanceable preview. */
function makePreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Classify one bundle file from its bytes. Derives kind, byte length, content hash,
 * and (for scripts) interpreter + noticed commands + a short preview. NOT a safety call.
 */
export function classifyBundleEntry(relPath: string, bytes: Buffer | string): BundleEntry {
  const text = typeof bytes === "string" ? bytes : bytes.toString("utf8");
  const byteLen = typeof bytes === "string" ? Buffer.byteLength(bytes, "utf8") : bytes.length;
  const hash = sha256(bytes);

  const base = baseName(relPath);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";

  const nlIdx = text.search(/\r?\n/);
  const firstLine = nlIdx === -1 ? text : text.slice(0, nlIdx);
  const shebang = firstLine.startsWith("#!") ? firstLine : undefined;

  let kind: BundleKind;
  if (base === "SKILL.md") kind = "instructions";
  else if (SCRIPT_EXTS.has(ext) || shebang) kind = "script";
  else if (REFERENCE_EXTS.has(ext)) kind = "reference";
  else kind = "asset";

  const entry: BundleEntry = { relPath, kind, bytes: byteLen, hash };
  if (shebang) entry.shebang = shebang;
  if (kind === "script") {
    if (ext) entry.lang = ext;
    const interpreter = interpreterFromShebang(shebang) ?? EXT_INTERPRETER[ext] ?? (ext || "sh");
    entry.exec = {
      interpreter,
      declaredCommands: declaredCommands(text),
      preview: makePreview(text),
    };
  }
  return entry;
}

/** A bundle file paired with its FULL content — the unit detectCapabilities scans. */
export interface FileContent {
  entry: BundleEntry;
  content: string;
}

/**
 * Aggregate a humble capabilities inventory across a bundle's script files plus the
 * SKILL.md body. Flags are textual signals we *noticed* (see header for limits).
 *
 * CONTRACT (D14, for the Wave-2 source adapter caller): the adapter reads files and so
 * HAS the full bytes — it passes each file as `{ entry, content }` carrying the FULL
 * `content`, NOT the truncated `exec.preview`. Flags AND commands are BOTH derived from
 * that same full `content`, which holds the invariant: no command is ever listed without
 * its applicable flag also firing when the signature is present anywhere in the file.
 * (Earlier this scanned flags over `exec.preview`'s first ~200 collapsed chars while
 * aggregating commands from full content — so a long friendly comment header could push a
 * `curl … | bash` / `rm -rf` past the preview and the headline security flags silently
 * vanished while the commands still showed. `exec.preview` remains on the entry purely as a
 * glanceable UI string and is NOT consulted here.)
 *
 * Non-script files (references/assets) may be passed through but are intentionally NOT
 * scanned — only the SKILL.md body (`body`) and `kind === "script"` files contribute.
 */
export function detectCapabilities(files: FileContent[], body: string): SkillCapabilities {
  const flags = new Set<CapabilityFlag>();
  const commands = new Set<string>();
  const interpreters = new Set<string>();
  let scriptCount = 0;

  // SKILL.md instructions — scanned in full.
  for (const f of flagsInText(body)) flags.add(f);
  for (const c of declaredCommands(body)) commands.add(c);

  for (const { entry, content } of files) {
    if (entry.kind !== "script") continue;
    scriptCount++;
    if (entry.exec) interpreters.add(entry.exec.interpreter);
    // Flags AND commands both derive from the SAME full content (D14 invariant) — never
    // from the truncated preview, so dangerous lines past char 200 still surface.
    for (const f of flagsInText(content)) flags.add(f);
    for (const c of declaredCommands(content)) commands.add(c);
  }

  return {
    scriptCount,
    interpreters: [...interpreters].sort(),
    commands: [...commands].sort(),
    flags: FLAG_ORDER.filter((f) => flags.has(f)),
  };
}
