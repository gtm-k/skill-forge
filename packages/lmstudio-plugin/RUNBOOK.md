# @skillforge/lmstudio — RUNBOOK (manual GUI build + validation)

This package is the **runtime half of the magic moment**: it reads the CLI-written
`~/.skillforge/manifest.json` + `sources/` tree, routes the chat to the right skill, and rewrites the
user's turn so LM Studio **persists** the injected skill instructions into the conversation.

> Note: a daemon-backed read model also ships now (`@skillforge/daemon`, node:sqlite + REST/SSE on 127.0.0.1) as an alternative to the embedded `~/.skillforge/` read path described below.

The selection + injection logic (`src/select-inject.ts`, `src/read-model.ts`, `src/embed.ts`,
`src/inject-log.ts`) is **fully headless and tested offline** (`test/select-inject.test.ts`). The only
piece that cannot be exercised in this repo is the LM Studio SDK glue (`src/promptPreprocessor.ts`),
because `@lmstudio/sdk` exists **only inside a built LM Studio plugin**. Wiring that glue into a real
plugin and validating it in the GUI is a **manual step (A0-B / D23) — it cannot be automated.**

---

## Why this step is manual

- `@lmstudio/sdk` is provided by the LM Studio plugin runtime, not by npm in this monorepo (house rule:
  zero new dependencies). `src/promptPreprocessor.ts` carries `// @ts-nocheck` and is never imported by
  tests for exactly this reason.
- `lms create` is **interactive-only** (it prompts for a template + identity) and is therefore unusable
  headlessly in CI. The supported path is to **clone an existing preprocessor plugin** and swap in our
  hook, then build it with `lms dev`.

---

## Build steps (one-time, on a machine with LM Studio installed)

1. **Locate the reference plugin.** Install/locate the official `lmstudio/rag-v1` prompt-preprocessor
   plugin (LM Studio › Discover › Plugins, or its source repo). It is the reference for the exact
   `preprocess(...)` signature your installed SDK version expects.

2. **Copy it to a new plugin folder**, e.g. `skillforge-lmstudio/`. Keep its `package.json`,
   `manifest.json`, and SDK wiring; you are only replacing the preprocessor body.

3. **Swap in our hook.** Replace the clone's `src/promptPreprocessor.ts` with this package's
   `src/promptPreprocessor.ts`. Then **adapt the imports/accessors** to the installed SDK shape:
   - `import { ... } from "@lmstudio/sdk"` — match the real exported controller/message type names.
   - Replace the relative `./select-inject.ts` import with the headless core. Two options:
     - vendor the four headless files (`select-inject.ts`, `read-model.ts`, `embed.ts`,
       `inject-log.ts`) into the plugin's `src/`, **or**
     - publish/`npm link` `@skillforge/lmstudio` and import `selectAndInject` from it.
   - Adapt `ctl.pullHistory()`, `ctl.getConversationId()`, `userMessage.getText()`,
     `m.getRole()/m.getText()` to the SDK's actual method names (the rag-v1 source shows the canonical
     ones for your version).

4. **Set a unique plugin identity.** In the clone's `manifest.json`, give it a distinct
   `owner/name` (e.g. `you/skillforge-lmstudio`) so it does not collide with `lmstudio/rag-v1`.

5. **Build + register with `lms dev`.** From the plugin folder run `lms dev`. This builds the plugin
   (bundling `@lmstudio/sdk`) and registers it with the running LM Studio instance. Do **not** use
   `lms create` (interactive-only). Leave `lms dev` running while you validate.

---

## Validate in the LM Studio GUI

1. **Add a skill via the CLI:** `skill-forge add <git-url-or-folder>`. Confirm
   `~/.skillforge/manifest.json` lists it and `~/.skillforge/sources/<sourceId>/<dir>/SKILL.md` exists.
   (If LM Studio's embeddings endpoint is reachable the CLI stores vectors; if not, routing still works
   on lexical + explicit — A0-A.)

2. **Open a GUI chat** in LM Studio with the plugin enabled, and send a message that clearly matches the
   added skill (or use an explicit `$slug`).

3. **Confirm the injection persisted.** The matching skill's instructions should appear **prepended to
   your user turn** in the saved transcript (channel = user-turn-rewrite), as
   `<skill block>\n\n<your message>`. Scroll back: the block stays in the conversation across turns, and
   it is **not** re-injected every turn (sticky guard, R1-B1).

4. **Check the byte-proof.** Open `~/.skillforge/inject.log.jsonl`; the last line records the turn:
   `slug`, `disclosure` (`full`/`menu`/`none`), `tier` (`explicit`/`lexical`/`semantic`/`none`),
   `injectedBytes` and `injectedLen`. Confirm `injectedBytes` equals the byte length of the block that
   landed in the transcript — this is the D11 self-verifying hand-off: **"fired" is proven by injected
   bytes, not by the selection decision.**

5. **Negative + ambiguous checks.** A query that matches nothing should leave your turn untouched and log
   a line with `slug: null`. A genuinely ambiguous query (two close matches) should inject a short
   **menu** (`disclosure: "menu"`) rather than guessing a sticky wrong skill.

### Injection-size ceiling to watch

Spike A0 measured that a **multi-KB** instruction block is honored by the user-turn rewrite, so the
default `maxTokens: 2000` budget lands intact. `buildInjection` GUARANTEES `tokenCost <= maxTokens` and
**downgrades** an over-budget full body to a menu (or to `none`) rather than handing a sticky channel an
over-budget block. If you raise the budget for a larger-context model, re-validate that the full block
still persists in the GUI transcript and is reflected by `injectedBytes` in the log.

> This GUI build + validation step is inherently manual — there is no headless API to drive the LM Studio
> chat UI or to register a plugin non-interactively beyond `lms dev`. Treat the headless test suite as the
> automated contract and this RUNBOOK as the human acceptance gate.
