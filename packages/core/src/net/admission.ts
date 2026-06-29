// @skillforge/core/net/admission — the SHARED admission gate (CSRF / DNS-rebinding defence) + local-origin
// CORS, the single source of truth for the daemon's control server AND the standalone proxy server (Wave C /
// D3). Before Wave C each server DECLARED its own byte-identical copy and they had already drifted on the
// refusal message ("daemon" vs "proxy"); the only legitimate difference — which service names itself in the
// message — is now a parameter, not a fork.
//
// WHY a server must refuse at admission and not rely on CORS: CORS only controls whether the BROWSER exposes
// the RESPONSE; it does NOT stop the server from EXECUTING the request (a CORS-safelisted simple POST runs the
// side effect before any header is read). So the server REFUSES a request it should never serve, BEFORE
// routing:
//   • Host header hostname MUST be local — a DNS-rebinding attack reaches us with the attacker's hostname in
//     Host (the browser sends the original name), so a non-local Host is rejected.
//   • when an Origin header is present, its hostname MUST also be local — kills the simple-POST CSRF (a
//     cross-origin browser request always carries Origin on POST/PATCH/DELETE).
// An Origin-ABSENT request with a local Host is a legitimate local non-browser client (the CLI / the daemon's
// own UI server) and is allowed. Applies to EVERY method (incl. OPTIONS), so a hostile preflight is rejected.
import type http from "node:http";

export const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Normalize a hostname for comparison: lowercase, strip IPv6 [..] brackets. */
export function normHost(h: string): string {
  return h.toLowerCase().replace(/^\[|\]$/g, "");
}

/** Hostname from a `Host` header (`host`, `host:port`, `[ipv6]:port`), or undefined. */
export function hostnameFromHostHeader(host: string | undefined): string | undefined {
  if (!host) return undefined;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? undefined : normHost(host.slice(1, end));
  }
  return normHost(host.split(":")[0] ?? "");
}

/** Hostname from an `Origin` header URL, or undefined (e.g. the opaque "null" origin). */
export function hostnameFromOrigin(origin: string): string | undefined {
  try {
    return normHost(new URL(origin).hostname);
  } catch {
    return undefined;
  }
}

export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const h = hostnameFromOrigin(origin);
  return h !== undefined && LOCAL_HOSTS.has(h);
}

/** Admit a request only when it cannot be a cross-site / rebinding attack. Returns a rejection reason string
 *  when it must be 403'd, or undefined when it is allowed. `serviceName` only flavours the refusal message
 *  (the SkillForge "daemon" vs "proxy") — the admission LOGIC is identical for both. */
export function admissionDenyReason(req: http.IncomingMessage, serviceName = "daemon"): string | undefined {
  const host = hostnameFromHostHeader(req.headers.host);
  if (host === undefined || !LOCAL_HOSTS.has(host)) {
    return `non-local Host header (possible DNS-rebinding) — the SkillForge ${serviceName} serves 127.0.0.1 only`;
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "" && !isLocalOrigin(origin)) {
    return `cross-origin request refused (CSRF) — only a local Origin may drive the ${serviceName}`;
  }
  return undefined;
}

/** CORS headers for a local-UI request: reflect ONLY a localhost/127.0.0.1 Origin (a public page must not be
 *  able to read the daemon's responses). Returns {} for any non-local / absent Origin. */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!isLocalOrigin(origin)) return {};
  return {
    "access-control-allow-origin": origin!,
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}
