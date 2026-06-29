// @skillforge/core/source/guards — restored v1 security guards for the sourcing funnel (§5 P0).
//
// HUMBLE framing: these are best-effort, OBSERVABLE guards — string/structure checks at a trust
// boundary, NOT a verdict that an input is "safe"/"trusted". In particular safeUrl is a hostname
// STRING check, not a resolver-level SSRF guard (see isBlockedHost). They exist so the funnel can
// refuse the obvious prototype-pollution and loopback/private-network vectors before they reach a
// downstream object-build or fetch.

/** Keys that, assigned onto a plain object built from untrusted input, can poison Object.prototype. */
export const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"] as const;

/**
 * Assign `value` at `key` on `obj` UNLESS `key` is a prototype-pollution vector (DANGEROUS_KEYS) — in
 * which case the write is REFUSED and `false` is returned (observable, never silent). Uses
 * Object.defineProperty so a permitted write is always an OWN data property and can never trigger a
 * setter (e.g. the "__proto__" accessor). Returns true when the value was actually set.
 */
export function safeAssign(obj: Record<string, unknown>, key: string, value: unknown): boolean {
  if ((DANGEROUS_KEYS as readonly string[]).includes(key)) return false;
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  return true;
}

/** Parse `u` and require an https: protocol. Throws on a malformed URL or any non-https scheme. */
export function assertHttpsUrl(u: string): URL {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new Error(`not a valid URL: ${JSON.stringify(u)}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`refusing non-https URL (protocol ${url.protocol}): ${JSON.stringify(u)}`);
  }
  return url;
}

// Best-effort loopback / link-local / RFC-1918 hostname patterns. HUMBLE: a STRING check only — it does
// NOT resolve DNS, so a public hostname that resolves to a private address, or decimal/hex/octal IPv4
// encodings, are NOT caught. A real fetch path must still verify at connect time AND re-run this on
// every redirect hop (see url.ts). IPv6 IS covered: loopback (::1), unspecified (::), link-local
// (fe80::/10), unique-local (fc00::/7), and IPv4-mapped (::ffff:a.b.c.d — which Node renders in hex as
// ::ffff:7f00:1; both forms normalize back to the embedded IPv4 and re-run the v4 rules).

/** The IPv4 loopback / link-local / RFC-1918 private rules, applied to a dotted-quad string. */
function isBlockedIpv4(h: string): boolean {
  if (h === "0.0.0.0") return true;
  if (/^127\./.test(h)) return true; // 127.0.0.0/8 loopback
  if (/^169\.254\./.test(h)) return true; // 169.254.0.0/16 link-local (incl. the cloud-metadata IP)
  if (/^10\./.test(h)) return true; // 10.0.0.0/8 private
  if (/^192\.168\./.test(h)) return true; // 192.168.0.0/16 private
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true; // 172.16.0.0/12 private
  return false;
}

/** Extract the embedded dotted IPv4 from an IPv4-mapped IPv6 — dotted (`::ffff:127.0.0.1`) or the hex
 *  form Node normalizes it to (`::ffff:7f00:1`). undefined when `h` is not IPv4-mapped. */
function mappedIpv4(h: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (hex) {
    const hi = parseInt(hex[1] ?? "", 16);
    const lo = parseInt(hex[2] ?? "", 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return undefined;
}

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 [..] brackets

  // ── IPv6 literal (an address carrying a colon; a DNS name never reaches these rules) ──
  if (h.includes(":")) {
    const v4 = mappedIpv4(h);
    if (v4 !== undefined) return isBlockedIpv4(v4); // IPv4-mapped → re-apply the v4 rules on the quad
    if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true; // loopback
    if (h === "::" || h === "0:0:0:0:0:0:0:0") return true; // unspecified
    if (/^fe[89ab][0-9a-f]/.test(h)) return true; // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}/.test(h)) return true; // fc00::/7 unique-local
    return false; // other (global) IPv6 — allowed; a humble string check, not a resolver
  }

  // ── DNS name or IPv4 ──
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  return isBlockedIpv4(h);
}

/**
 * assertHttpsUrl + a best-effort SSRF hostname reject (loopback / link-local / RFC-1918 private).
 * Throws on a blocked host. See isBlockedHost: this is a string check, not a resolver-level guard.
 */
export function safeUrl(input: string): URL {
  const url = assertHttpsUrl(input);
  if (isBlockedHost(url.hostname)) {
    throw new Error(`refusing SSRF-prone host ${JSON.stringify(url.hostname)} in ${JSON.stringify(input)}`);
  }
  return url;
}
