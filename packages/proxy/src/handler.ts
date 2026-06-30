// @skillforge/proxy/handler — the daemon-mountable request handlers for the OpenAI-compat proxy.
//
// createProxyHandler(deps) returns two RouteHandler-compatible functions (structurally assignable to the
// daemon's RouteHandler — see http-types.ts) that BOTH back the standalone server (server.ts) AND can be
// mounted into the daemon in Wave B via proxyRoutes(). The handlers hijack the socket (ctx.res) to pass the
// upstream response through; early validation/config errors return a JsonResponse instead.
//
// /v1/chat/completions — the inject path (R1-B1, D5, D15, M-embed):
//   1. pool = skills enabledFor.proxy (selectForProxy → loadCatalog(home,"proxy")).
//   2. X-Skill header: "<slug>" forces a Tier-0 explicit selection; "off" disables injection (pure passthrough).
//   3. otherwise the SAME cascade as the daemon route-test (selectWithEscalation → buildInjection).
//   4. place the injection as an EPHEMERAL system message at the front of a COPY of `messages` (never persisted).
//   5. forward the mutated request to config.upstreams.proxy.chatBaseUrl; streaming is piped through untouched.
//   Observability (actor-observability / never-silent): every request appends a select.log.jsonl line AND the
//   response carries X-Skill-Injected / X-Skill-Disclosure / X-Skill-Tier, plus X-Skill-Tier2: disabled when
//   semantic Tier-2 was unavailable (M-embed: a degraded route is visible, the proxy keeps routing on Tier 0/1).
//
// /v1/embeddings — passthrough to the INDEPENDENTLY-configured embeddings provider (config.embeddings, M-embed):
//   never inferred from the chat upstream; this is also the provider the proxy itself uses for Tier-2.
import { sha256, type FetchLike } from "@skillforge/core";
import { resolveEmbeddingsUrl, readBodyBounded, respondPayloadTooLarge } from "@skillforge/core";
import type { DaemonConfig } from "@skillforge/contracts/api";
import type { JsonResponse, ReqCtx, RouteDef, RouteHandler } from "./http-types.ts";
import { selectForProxy } from "./select.ts";
import { placeSystemEphemeral } from "./inject.ts";
import {
  forwardToUpstream,
  resolveChatUrl,
  UpstreamUnreachable,
  UpstreamTimeout,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  type ChatFetch,
} from "./forward.ts";
import { appendSelectLog, type SelectLogLine } from "./select-log.ts";

/** Default request-body cap (bytes). Chat payloads carry whole conversations, so this is larger than the
 *  daemon's 1MB control-API cap; an over-cap body is rejected with 413 (bounded read — local-DoS defence). */
export const DEFAULT_MAX_BODY_BYTES = 10_000_000;

export interface ProxyDeps {
  /** the SkillForge home (read-model + sources/ + select.log.jsonl live here). */
  home: string;
  /** the current resolved config (a getter so the daemon can hand its live config in Wave B). */
  config: () => DaemonConfig;
  /** injected outbound fetch for the chat + embeddings PASSTHROUGH (default = global fetch). */
  fetchImpl?: ChatFetch;
  /** injected fetch for the Tier-2 QUERY-EMBED provider (default = global fetch inside createEmbedProvider). */
  embedFetch?: FetchLike;
  /** override the select-log sink (default appends home/select.log.jsonl). Tests can capture lines in memory. */
  logSelect?: (line: SelectLogLine) => void;
  /** request-body cap in bytes (default DEFAULT_MAX_BODY_BYTES). */
  maxBodyBytes?: number;
  /** outbound connect + initial-response deadline (ms). Takes precedence over config.upstreams.proxy.timeoutMs;
   *  both fall back to DEFAULT_UPSTREAM_TIMEOUT_MS. A dead upstream then fails VISIBLY (504), never hangs. */
  timeoutMs?: number;
}

/** Cap for the X-Skill-Warnings response header (a bounded, sanitized CSV — never an unbounded header). */
const MAX_WARNINGS_HEADER = 512;

/** Render select warnings as a single bounded, header-safe value (printable ASCII, " | "-joined, truncated). */
function warningsHeaderValue(warnings: readonly string[]): string {
  const joined = warnings
    .map((w) => w.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7E]/g, ""))
    .join(" | ");
  return joined.length > MAX_WARNINGS_HEADER ? `${joined.slice(0, MAX_WARNINGS_HEADER)} [truncated]` : joined;
}

/** Resolve the outbound timeout: an explicit ProxyDeps override wins, else config.upstreams.proxy.timeoutMs (read
 *  defensively — contracts carries no such field yet, Wave B), else the default. Non-positive values are ignored. */
function resolveTimeoutMs(deps: ProxyDeps, cfg: DaemonConfig): number {
  if (typeof deps.timeoutMs === "number" && deps.timeoutMs > 0) return deps.timeoutMs;
  const fromConfig = (cfg.upstreams?.proxy as { timeoutMs?: unknown } | undefined)?.timeoutMs;
  if (typeof fromConfig === "number" && Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  return DEFAULT_UPSTREAM_TIMEOUT_MS;
}

export interface ProxyHandlers {
  /** POST /v1/chat/completions */
  chat: RouteHandler;
  /** POST /v1/embeddings */
  embeddings: RouteHandler;
}

/** First value of a possibly-array header. */
function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

type ParsedBody = Record<string, unknown>;

/** Obtain the parsed JSON body: prefer a host-pre-parsed ctx.body, else read+parse ctx.req (raw routing). */
async function getBody(
  ctx: ReqCtx,
  cap: number,
): Promise<{ ok: true; body: ParsedBody } | { ok: false; status: 400 | 413; error: string }> {
  if (ctx.body !== undefined && ctx.body !== null) {
    return typeof ctx.body === "object"
      ? { ok: true, body: ctx.body as ParsedBody }
      : { ok: false, status: 400, error: "invalid-json" };
  }
  const read = await readBodyBounded(ctx.req, cap);
  if (!read.ok) return { ok: false, status: 413, error: "payload-too-large" };
  if (read.raw.trim() === "") return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(read.raw) as ParsedBody };
  } catch {
    return { ok: false, status: 400, error: "invalid-json" };
  }
}

/** Turn a getBody failure into the right response. 400 invalid-json returns a JsonResponse the host serializes.
 *  413 over-cap is handled HERE via respondPayloadTooLarge (core/net): it writes a reliable 413 and BOUNDED-
 *  LINGER-closes the socket (resume-and-discard the rest of the upload for a bounded window so the client READS
 *  the status even mid-upload, then `connection: close` + force-shut), returning undefined — the handler has
 *  taken over the socket. This is the SAME shared mechanism the daemon's own control routes use; the proxy no
 *  longer hand-rolls the `connection: close` header (the old copy of the daemon's inline-413 fix).
 *
 *  NOTE (intentional, security-neutral behavior delta): when the proxy is MOUNTED in the daemon (raw route),
 *  writing the 413 here bypasses the daemon's generic cors-merging dispatch, so the mounted over-cap 413 no
 *  longer carries CORS headers (pre-Wave-C it did). Absent CORS only REDUCES a cross-origin page's ability to
 *  READ the response, never increases it — and the standalone proxy never emitted CORS at all, so this is the
 *  more consistent behavior. The proxy module is intentionally host-agnostic and must not own the daemon's CORS. */
function bodyErrorResponse(ctx: ReqCtx, fail: { status: 400 | 413; error: string }, cap: number): JsonResponse | undefined {
  if (fail.status === 413) {
    respondPayloadTooLarge(ctx.req, ctx.res, cap);
    return undefined;
  }
  return { status: 400, body: { error: fail.error } };
}

export function createProxyHandler(deps: ProxyDeps): ProxyHandlers {
  const cap = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = deps.logSelect ?? ((line: SelectLogLine): void => appendSelectLog(deps.home, line));

  /** Map a thrown outbound failure to a clean, VISIBLE status — but only when no byte has been written yet.
   *  Unreachable ⇒ 502, timeout ⇒ 504; if headers already went out we can only end the socket (never hang it). */
  const upstreamError = (ctx: ReqCtx, e: unknown): JsonResponse | undefined => {
    if (e instanceof UpstreamUnreachable || e instanceof UpstreamTimeout) {
      if (ctx.res.headersSent) {
        if (!ctx.res.writableEnded) ctx.res.end();
        return undefined;
      }
      return e instanceof UpstreamTimeout
        ? { status: 504, body: { error: "upstream-timeout", message: e.message } }
        : { status: 502, body: { error: "upstream-unreachable", message: e.message } };
    }
    throw e as Error;
  };

  const chat: RouteHandler = async (ctx: ReqCtx): Promise<JsonResponse | undefined> => {
    const cfg = deps.config();
    const chatBaseUrl = cfg.upstreams?.proxy?.chatBaseUrl;
    if (!chatBaseUrl) {
      return {
        status: 502,
        body: { error: "no-upstream", message: "no proxy upstream configured (config.upstreams.proxy.chatBaseUrl)" },
      };
    }

    const parsed = await getBody(ctx, cap);
    if (!parsed.ok) return bodyErrorResponse(ctx, parsed, cap);
    const body = parsed.body;

    const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
    const stream = body.stream === true;
    const authorization = firstHeader(ctx.req.headers["authorization"]);
    const url = resolveChatUrl(chatBaseUrl);

    const timeoutMs = resolveTimeoutMs(deps, cfg);
    const directive = firstHeader(ctx.req.headers["x-skill"])?.trim();
    const off = directive?.toLowerCase() === "off";

    // X-Skill: off → pure passthrough (no selection, no injection) — still audited (never-silent).
    if (off) {
      log({
        ts: new Date().toISOString(),
        traceId: sha256(`off:${deps.home}`).slice(0, 12),
        channel: "system-ephemeral",
        slug: null,
        disclosure: "none",
        injectedBytes: 0,
        injectedLen: 0,
        tier: "none",
        forced: "off",
        reasons: [],
      });
      try {
        await forwardToUpstream({
          url,
          body,
          stream,
          res: ctx.res,
          extraHeaders: { "x-skill-injected": "none", "x-skill-disclosure": "none" },
          timeoutMs,
          ...(authorization ? { authorization } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
      } catch (e) {
        return upstreamError(ctx, e);
      }
      return undefined;
    }

    const forcedSlug = directive ? directive.toLowerCase() : undefined;

    let result;
    try {
      result = await selectForProxy({
        home: deps.home,
        messages: messages as { role?: string; content?: unknown }[],
        config: cfg,
        ...(forcedSlug ? { forcedSlug } : {}),
        ...(deps.embedFetch ? { embedFetch: deps.embedFetch } : {}),
      });
    } catch (e) {
      return { status: 500, body: { error: "select-failed", message: (e as Error).message } };
    }

    const willInject = result.injection.disclosure !== "none" && messages.length > 0;
    const outMessages = willInject ? placeSystemEphemeral(messages, result.injection.text) : messages;
    const outBody: ParsedBody = { ...body, messages: outMessages };
    const slug = willInject ? result.injection.injectedSlugs[0] ?? null : null;

    const extraHeaders: Record<string, string> = {
      "x-skill-injected": slug ?? "none",
      "x-skill-disclosure": result.injection.disclosure,
      "x-skill-tier": result.selection.mode,
    };
    if (result.tierDisabled) extraHeaders["x-skill-tier2"] = "disabled";
    // never-silent: surface non-fatal injection degradations on a bounded response header (the second observable
    // place alongside the select.log line below) — they were previously computed but swallowed.
    if (result.warnings.length > 0) extraHeaders["x-skill-warnings"] = warningsHeaderValue(result.warnings);

    const line: SelectLogLine = {
      ts: new Date().toISOString(),
      traceId: sha256(result.query + deps.home).slice(0, 12),
      channel: "system-ephemeral",
      slug,
      disclosure: result.injection.disclosure,
      injectedBytes: willInject ? result.injection.injectedBytes : 0,
      injectedLen: willInject ? result.injection.text.length : 0,
      tier: result.selection.mode,
      reasons: result.selection.chosen?.reasons ?? [],
    };
    if (result.tierDisabled) line.tier2Disabled = result.tierDisabled.reason;
    if (forcedSlug) line.forced = forcedSlug;
    if (result.warnings.length > 0) line.warnings = result.warnings;
    log(line);

    try {
      await forwardToUpstream({
        url,
        body: outBody,
        stream,
        res: ctx.res,
        extraHeaders,
        timeoutMs,
        ...(authorization ? { authorization } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    } catch (e) {
      return upstreamError(ctx, e);
    }
    return undefined;
  };

  const embeddings: RouteHandler = async (ctx: ReqCtx): Promise<JsonResponse | undefined> => {
    const cfg = deps.config();
    if (!cfg.embeddings) {
      return {
        status: 502,
        body: {
          error: "no-embeddings-provider",
          message: "no embeddings provider configured (config.embeddings) — embeddings passthrough disabled",
        },
      };
    }
    const parsed = await getBody(ctx, cap);
    if (!parsed.ok) return bodyErrorResponse(ctx, parsed, cap);
    const authorization = firstHeader(ctx.req.headers["authorization"]);
    try {
      await forwardToUpstream({
        url: resolveEmbeddingsUrl(cfg.embeddings.baseUrl),
        body: parsed.body,
        stream: false,
        res: ctx.res,
        extraHeaders: { "x-skill-passthrough": "embeddings" },
        timeoutMs: resolveTimeoutMs(deps, cfg),
        ...(authorization ? { authorization } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    } catch (e) {
      return upstreamError(ctx, e);
    }
    return undefined;
  };

  return { chat, embeddings };
}

/** RouteDef[] for Wave B to mount into the daemon's server (raw:true ⇒ the handler reads the body itself). */
export function proxyRoutes(deps: ProxyDeps): RouteDef[] {
  const h = createProxyHandler(deps);
  return [
    { method: "POST", pattern: "/v1/chat/completions", raw: true, handler: h.chat },
    { method: "POST", pattern: "/v1/embeddings", raw: true, handler: h.embeddings },
  ];
}
