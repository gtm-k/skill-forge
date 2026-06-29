// @skillforge/proxy/http-types — the daemon-mountable handler contract.
//
// Before Wave C these four shapes were DECLARED here as a structural mirror of the daemon's. They now live in
// @skillforge/contracts/http-route as the single source of truth (D3 leverage convergence): the proxy and the
// daemon import the SAME RouteDef/RouteHandler/ReqCtx/JsonResponse, so a handler typed here is assignable
// wherever the daemon expects its own — by shared definition now, not by hoping two copies stay byte-identical.
// PLAN §2's "an adapter must not import the daemon or a sibling adapter" is still honored: contracts is the
// shared base both already depend on, not an adapter. This module re-exports so existing `from "./http-types.ts"`
// import sites (handler.ts, index.ts) are unchanged.
export type { JsonResponse, ReqCtx, RouteHandler, RouteDef } from "@skillforge/contracts/http-route";
