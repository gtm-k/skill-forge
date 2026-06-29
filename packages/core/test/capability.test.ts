// Capability detector gate — proves the HUMBLE inventory notices the signatures it claims
// to (and does not over-fire on benign prose). These are real behavior assertions, not
// theater. We import capability.ts directly: the @skillforge/core barrel does not yet
// re-export it (the orchestrator wires that).

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBundleEntry, detectCapabilities } from "../src/capability.ts";

// Mirrors the Wave-2 source adapter: it has read the bytes, so it hands detectCapabilities
// each file as { entry, content } carrying the FULL content (NOT the truncated preview).
function file(relPath: string, content: string) {
  return { entry: classifyBundleEntry(relPath, content), content };
}

test("classifyBundleEntry: SKILL.md is instructions", () => {
  const e = classifyBundleEntry("SKILL.md", "---\nname: x\n---\nbody text here that is fine");
  assert.equal(e.kind, "instructions");
  assert.equal(e.exec, undefined);
  assert.ok(e.bytes > 0);
  assert.match(e.hash, /^[0-9a-f]{64}$/);
});

test("classifyBundleEntry: shebang promotes an extensionless file to a script + interpreter", () => {
  const e = classifyBundleEntry("hooks/pre-commit", "#!/usr/bin/env python3\nprint('hi')\n");
  assert.equal(e.kind, "script");
  assert.equal(e.shebang, "#!/usr/bin/env python3");
  assert.equal(e.exec?.interpreter, "python3");
});

test("classifyBundleEntry: a .sh shebang resolves the interpreter from the shebang", () => {
  const e = classifyBundleEntry("setup.sh", "#!/bin/bash\necho ok\n");
  assert.equal(e.kind, "script");
  assert.equal(e.lang, "sh");
  assert.equal(e.exec?.interpreter, "bash");
});

test("classifyBundleEntry: preview is whitespace-collapsed and bounded", () => {
  const e = classifyBundleEntry("a.sh", "echo   one\n\n\techo   two");
  assert.ok(e.exec);
  assert.ok(!e.exec.preview.includes("\n"));
  assert.ok(e.exec.preview.length <= 200);
  assert.equal(e.exec.preview, "echo one echo two");
});

test("detect: curl piped to sh flags BOTH network and pipe-to-shell", () => {
  const caps = detectCapabilities([file("install.sh", "#!/bin/sh\ncurl https://example.com/x | sh\n")], "");
  assert.ok(caps.flags.includes("network"), `flags=${caps.flags}`);
  assert.ok(caps.flags.includes("pipe-to-shell"), `flags=${caps.flags}`);
  assert.ok(caps.commands.includes("curl"));
});

test("detect: rm -rf flags destructive (and records the command)", () => {
  const caps = detectCapabilities([file("clean.sh", "rm -rf /tmp/x\n")], "");
  assert.ok(caps.flags.includes("destructive"), `flags=${caps.flags}`);
  assert.ok(caps.commands.includes("rm"));
  assert.ok(!caps.flags.includes("network"));
});

test("detect: pip install flags install", () => {
  const caps = detectCapabilities([file("deps.sh", "pip install requests\n")], "");
  assert.ok(caps.flags.includes("install"), `flags=${caps.flags}`);
  assert.ok(caps.commands.includes("pip"));
});

test("detect: eval(...) flags eval", () => {
  const caps = detectCapabilities([file("run.js", "eval($x)\n")], "");
  assert.ok(caps.flags.includes("eval"), `flags=${caps.flags}`);
  assert.ok(caps.commands.includes("eval"));
});

test("detect: redirection to a path flags fs-write", () => {
  const caps = detectCapabilities([file("w.sh", "echo hi > /etc/foo\n")], "");
  assert.ok(caps.flags.includes("fs-write"), `flags=${caps.flags}`);
  assert.ok(caps.commands.includes("echo"));
});

test("detect: a benign reference .md contributes no script flags", () => {
  const ref = file("docs/guide.md", "# Guide\n\nThis is prose about pasta. No code here.\n");
  assert.equal(ref.entry.kind, "reference");
  const caps = detectCapabilities([ref], "");
  assert.deepEqual(caps.flags, []);
  assert.equal(caps.scriptCount, 0);
  assert.deepEqual(caps.commands, []);
});

test("detect: interpreters + scriptCount aggregate across multiple script entries", () => {
  const a = file("a.sh", "#!/bin/bash\ncurl https://h/x | sh\n");
  const b = file("b.py", "#!/usr/bin/env python3\nimport os\nprint('hi')\n");
  const ref = file("notes.txt", "just some notes, not a script\n");
  const caps = detectCapabilities([a, b, ref], "");
  assert.equal(caps.scriptCount, 2); // the .txt reference is not counted
  assert.deepEqual(caps.interpreters, ["bash", "python3"]);
  assert.ok(caps.flags.includes("network"));
  assert.ok(caps.flags.includes("pipe-to-shell"));
  // the python script imports os / prints — nothing destructive/install/eval there
  assert.ok(!caps.flags.includes("destructive"));
  assert.ok(!caps.flags.includes("install"));
});

test("detect: the SKILL.md body itself is scanned for signatures", () => {
  const body = "Setup:\n\n```\nnpm install left-pad\ncurl https://h | bash\n```\n";
  const caps = detectCapabilities([], body);
  assert.ok(caps.flags.includes("install"), `flags=${caps.flags}`);
  assert.ok(caps.flags.includes("network"));
  assert.ok(caps.flags.includes("pipe-to-shell"));
  assert.ok(caps.commands.includes("npm"));
  assert.ok(caps.commands.includes("curl"));
});

test("flags are emitted in a stable canonical order", () => {
  // a script that trips several signals at once
  const caps = detectCapabilities(
    [file("do.sh", "#!/bin/bash\ncurl https://h/x | bash\nrm -rf /tmp/y\npip install requests\necho hi > /etc/z\n")],
    "",
  );
  const order = ["network", "pipe-to-shell", "destructive", "eval", "install", "fs-write"];
  const expected = order.filter((f) => caps.flags.includes(f as (typeof caps.flags)[number]));
  assert.deepEqual(caps.flags, expected);
});

test("detect: a dangerous signature PAST the 200-char preview window still flags (D14 — full-content scan)", () => {
  // A realistic install.sh: a long, friendly comment header (>200 collapsed chars) and only
  // THEN the dangerous lines. classifyBundleEntry's preview is truncated and cannot see them;
  // detectCapabilities must scan the FULL content so the headline flags still fire. This test
  // FAILS against the old preview-only scan and PASSES once flags read full content.
  const header =
    "#!/bin/bash\n" +
    "# This script prepares a fresh developer machine for the project.\n" +
    "# It walks through each step slowly and explains the reasoning so that\n" +
    "# a brand-new contributor can follow along without any prior context, and\n" +
    "# so that anyone auditing the setup later understands exactly why each\n" +
    "# step exists and what tradeoffs were weighed before settling on it.\n";
  const danger = "curl -fsSL https://example.com/install.sh | bash\nrm -rf /tmp/build\n";
  const f = file("install.sh", header + danger);

  // Guard: the dangerous lines really do sit PAST the preview window — else this proves nothing.
  assert.ok(f.entry.exec, "script should classify with exec");
  assert.ok(f.entry.exec.preview.length <= 200);
  assert.ok(!f.entry.exec.preview.includes("curl"), "the curl line must sit past the preview window");
  assert.ok(!f.entry.exec.preview.includes("rm -rf"), "the rm -rf line must sit past the preview window");

  // Full-content scan: the headline security flags fire despite the long benign header.
  const caps = detectCapabilities([f], "");
  assert.ok(caps.flags.includes("network"), `flags=${caps.flags}`);
  assert.ok(caps.flags.includes("pipe-to-shell"), `flags=${caps.flags}`);
  assert.ok(caps.flags.includes("destructive"), `flags=${caps.flags}`);
  // Invariant: no command is listed without its applicable flag also firing.
  assert.ok(caps.commands.includes("curl"));
  assert.ok(caps.commands.includes("rm"));
});

// ── B4: Windows/PowerShell + Node/Python network/install signatures ──────────────
// The owner is on Windows 11 and `.ps1` files classify as scripts (interpreter "powershell"),
// yet the original signatures noticed ZERO PowerShell patterns — a real blind spot. Each test
// below uses a form that the OLD signatures could NOT have matched (no literal `://`, no `rm`,
// no `npm/pip/...`), so it FAILS pre-fix and PASSES post-fix.

test("detect: PowerShell Invoke-WebRequest flags network without a literal URL [B4]", () => {
  // No `https://` literal here, so the old `https?://` alternative cannot fire — only the new
  // Invoke-WebRequest signature can. (Verified: old code yields flags=[] for this input.)
  const caps = detectCapabilities([file("get.ps1", "Invoke-WebRequest -Uri $endpoint -OutFile out.bin\n")], "");
  assert.equal(caps.interpreters[0], "powershell");
  assert.ok(caps.flags.includes("network"), `flags=${caps.flags}`);
  assert.ok(caps.commands.includes("invoke-webrequest"), `commands=${caps.commands}`);
});

test("detect: PowerShell iwr/irm aliases + Start-BitsTransfer flag network (case-insensitive) [B4]", () => {
  // lowercase `start-bitstransfer` proves the PowerShell entry matches case-INSENSITIVELY.
  const caps = detectCapabilities(
    [file("dl.ps1", "iwr -Uri $u -OutFile a\nirm $api\nstart-bitstransfer -Source $s -Destination d\n")],
    "",
  );
  assert.ok(caps.flags.includes("network"), `flags=${caps.flags}`);
  assert.ok(caps.commands.includes("iwr"), `commands=${caps.commands}`);
});

test("detect: Node https.request / net.connect flag network [B4]", () => {
  // `https.request(` has no `://`, so the old network alternatives cannot fire.
  const caps = detectCapabilities(
    [file("client.js", "const https = require('https')\nconst req = https.request(opts, cb)\nconst s = net.connect(443, host)\n")],
    "",
  );
  assert.ok(caps.flags.includes("network"), `flags=${caps.flags}`);
});

test("detect: Python socket module flags network [B4]", () => {
  // `import socket` / `socket.socket(` were invisible to the old signatures.
  const caps = detectCapabilities(
    [file("net.py", "import socket\ns = socket.socket()\ns.connect((host, port))\n")],
    "",
  );
  assert.equal(caps.interpreters[0], "python");
  assert.ok(caps.flags.includes("network"), `flags=${caps.flags}`);
});

test("detect: PowerShell Remove-Item -Recurse -Force flags destructive [B4]", () => {
  // "Remove-Item" contains no `rm` token and there is no `format X:`, so old destructive can't fire.
  const caps = detectCapabilities([file("clean.ps1", "Remove-Item -Recurse -Force C:\\tmp\\build\n")], "");
  assert.ok(caps.flags.includes("destructive"), `flags=${caps.flags}`);
  assert.ok(caps.commands.includes("remove-item"), `commands=${caps.commands}`);
  assert.ok(!caps.flags.includes("network"), `flags=${caps.flags}`);
});

test("detect: PowerShell Remove-Item with ABBREVIATED -Re -Fo flags destructive [B4 re-gate]", () => {
  // PowerShell resolves unique-prefix flags, so `-Re -Fo` == `-Recurse -Force`. The full-spelling
  // regex evaded this; the prefix-stem regex must catch it (and the reversed order).
  const abbrev = detectCapabilities([file("wipe.ps1", "Remove-Item -Re -Fo C:\\Windows\\System32\n")], "");
  assert.ok(abbrev.flags.includes("destructive"), `abbrev flags=${abbrev.flags}`);
  const reversed = detectCapabilities([file("wipe2.ps1", "Remove-Item -Force -Recurse C:\\tmp\\x\n")], "");
  assert.ok(reversed.flags.includes("destructive"), `reversed flags=${reversed.flags}`);
  // abbreviated AND reversed together (re-gate minor note)
  const abbrevRev = detectCapabilities([file("wipe3.ps1", "Remove-Item -Fo -Re C:\\tmp\\y\n")], "");
  assert.ok(abbrevRev.flags.includes("destructive"), `abbrevRev flags=${abbrevRev.flags}`);
  // a STANDALONE ri alias still fires (the (?<!-) lookbehind must not over-exclude it)
  const alias = detectCapabilities([file("a.ps1", "ri -Re -Fo C:\\tmp\\z\n")], "");
  assert.ok(alias.flags.includes("destructive"), `alias flags=${alias.flags}`);
});

test("detect: a Unix grep with combined -ri/-Fo flags is NOT destructive [B4 re-gate false-positive]", () => {
  // The `(?<!-)` lookbehind exists for exactly this: `\bri\b` matches the `ri` inside `-ri` (the
  // `-`->`r` word boundary), and `-Fo` matches grep's combined `-F -o`. Without the lookbehind this
  // innocent line false-flagged destructive.
  const grep = detectCapabilities([file("search.sh", "grep -ri -Fo needle .\n")], "");
  assert.ok(!grep.flags.includes("destructive"), `should NOT be destructive: flags=${grep.flags}`);
});

test("detect: bare Remove-Item (no -Recurse/-Force) is NOT destructive nor listed [B4/D14 consistency]", () => {
  // D14 invariant: a command is only listed when its flag also fires. Remove-Item without a
  // destructive switch must NOT flag destructive AND must NOT appear in the commands inventory.
  const caps = detectCapabilities([file("rm.ps1", "Remove-Item C:\\tmp\\one.txt\n")], "");
  assert.ok(!caps.flags.includes("destructive"), `flags=${caps.flags}`);
  assert.ok(!caps.commands.includes("remove-item"), `commands=${caps.commands}`);
});

test("detect: winget/choco/Install-Module flag install [B4]", () => {
  const caps = detectCapabilities(
    [file("setup.ps1", "winget install Git.Git\nInstall-Module Pester\nchoco install jq\n")],
    "",
  );
  assert.ok(caps.flags.includes("install"), `flags=${caps.flags}`);
  assert.ok(caps.commands.includes("winget"), `commands=${caps.commands}`);
  assert.ok(caps.commands.includes("install-module"), `commands=${caps.commands}`);
});

test("case discipline: lowercase JS function() stays non-eval; lowercase PowerShell cmdlet still flags [B4]", () => {
  // The case-SENSITIVE `Function(` signature must NOT be loosened: a lowercase `function(`
  // declaration is not eval. The NEW PowerShell entries, by contrast, ARE case-insensitive.
  const js = detectCapabilities([file("f.js", "const f = function(x) { return x + 1 }\n")], "");
  assert.ok(!js.flags.includes("eval"), `flags=${js.flags}`);
  const ps = detectCapabilities([file("g.ps1", "invoke-webrequest -uri $u -outfile a\n")], "");
  assert.ok(ps.flags.includes("network"), `flags=${ps.flags}`);
});

test("detect: a generic db.connect() does NOT flag network (socket connect anchored to its tuple) [B4]", () => {
  // The Python socket connect is anchored to `.connect((host, port))` so a bare db/client
  // `.connect()` is not mistaken for network traffic — limits over-flag while honoring humility.
  const caps = detectCapabilities([file("db.js", "const c = db.connect()\nawait c.query('select 1')\n")], "");
  assert.ok(!caps.flags.includes("network"), `flags=${caps.flags}`);
});
