# @skillforge/lmstudio — RUNBOOK (build + GUI validation)

This package is the **runtime half of the magic moment**: it reads the CLI/daemon-written
`~/.skillforge/manifest.json` + `sources/` tree, routes the chat to the right skill, and rewrites the
user's turn so LM Studio **persists** the injected skill instructions into the conversation.

> A daemon-backed read model also ships (`@skillforge/daemon`, node:sqlite + REST/SSE on 127.0.0.1) as an
> alternative source for the same `~/.skillforge/` read path the plugin consumes.

The selection + injection logic (`src/select-inject.ts`, `src/read-model.ts`, `src/embed.ts`,
`src/inject-log.ts`) is **fully headless and tested offline** (`test/select-inject.test.ts`). The only
pieces that cannot be exercised in this repo are the LM Studio SDK glue (`src/index.ts`,
`src/promptPreprocessor.ts`), because `@lmstudio/sdk` exists **only inside a built LM Studio plugin**. They
are type-checked against an ambient SDK stub (`src/lmstudio-sdk.d.ts`) that models the **real** SDK shapes;
the only thing left for a human is sending a GUI chat and eyeballing the persisted block (A0-B / D18 / D23).

---

## Build it (one command)

`scripts/build-lmstudio-plugin.mjs` assembles a runnable plugin: it clones LM Studio's reference RAG-v1
preprocessor (which provides the real `@lmstudio/sdk` + the `lms dev` build wiring), swaps in this package's
glue + headless runtime, vendors `@skillforge/core`/`@skillforge/contracts` under `src/`, and generates a
**complete** `imports` map for every vendored subpath.

```bash
# Prereq: install LM Studio's "RAG v1" plugin once (LM Studio → Discover → Plugins).
node scripts/build-lmstudio-plugin.mjs          # → ~/.lmstudio-skillforge-plugin (override with a destDir arg)
cd ~/.lmstudio-skillforge-plugin && lms dev      # builds + registers; leave running. (NOT `lms create` — interactive-only)
```

`lms dev` should print `[esbuild] build finished, watching for changes...` then
`[PromptPreprocessor] Register with LM Studio`.

### Two non-obvious gotchas the script encodes (read if you build by hand)

1. **The real SDK's `pullHistory()` returns a `Chat`, not an array** — read the turns via
   `chat.getMessagesArray()`. (An earlier stub typed it as `ChatMessage[]`, so `history.map(...)`
   type-checked but threw at runtime → the plugin never injected. `src/lmstudio-sdk.d.ts` now reflects
   reality, and SDK 1.5.0 exposes **no conversation id** to a preprocessor, so the sticky guard is a single
   process-global slot.)
2. **Vendored `.ts` deps must live under `src/`, not `node_modules/`** — LM Studio's dev runner refuses to
   type-strip `.ts` files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). The script
   vendors core/contracts to `src/vendor/**` and rewrites `@skillforge/*` → `#skillforge/*` subpath imports.

---

## Validate in the LM Studio GUI (the one manual step)

1. **Add a skill into the home LM Studio reads.** LM Studio is a separate GUI app and does **not** inherit a
   shell's `SKILLFORGE_HOME` export — it reads `~/.skillforge`. So add with `SKILLFORGE_HOME` unset:
   ```bash
   SKILLFORGE_HOME= node --experimental-strip-types packages/cli/src/bin.ts add <git-url-or-folder>
   ```
   Confirm `~/.skillforge/manifest.json` lists it (`enabledFor.lmstudio: true`) and
   `~/.skillforge/sources/<sourceId>/<dir>/SKILL.md` exists. (If a daemon is running against `~/.skillforge`,
   stop it first so it doesn't rewrite that manifest.)

2. **Open a GUI chat** with the plugin enabled and send a message that clearly matches the skill (or an
   explicit `$slug`).

3. **Confirm the injection persisted.** The skill's instructions appear **prepended to your user turn**
   (`<skill block>\n\n<your message>`), and **stay** across turns (sticky guard, not re-injected every turn).

4. **Byte-proof.** `tail -n 1 ~/.skillforge/inject.log.jsonl` records `slug`, `disclosure`
   (`full`/`menu`/`none`), `tier`, `injectedBytes`, `injectedLen`. `injectedBytes` equals the bytes that
   landed — the D11 self-verifying hand-off: **"fired" is proven by injected bytes, not by the decision.**

5. **Negative + ambiguous.** A no-match leaves your turn untouched and logs `slug: null`. A genuinely
   ambiguous query injects a short **menu** (`disclosure: "menu"`) rather than guessing a sticky wrong skill.

### Injection-size ceiling

`buildInjection` GUARANTEES `tokenCost <= maxTokens` (default 2000) and **downgrades** an over-budget full
body to a menu (or `none`) rather than handing the sticky channel an over-budget block. If you raise the
budget for a larger-context model, re-validate that the full block still persists in the transcript and is
reflected by `injectedBytes`.

> This GUI validation is inherently manual — there is no headless API to drive the LM Studio chat UI or to
> register a plugin beyond `lms dev`. Treat the headless suite as the automated contract and this RUNBOOK as
> the human acceptance gate.
