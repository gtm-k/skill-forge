// @skillforge/lmstudio/read-model — thin re-export of the standalone read-model reader now in core.
//
// The reader (loadCatalog/loadInstructions/LoadedCatalog) was promoted verbatim into @skillforge/core
// (src/read-model/) so the MCP and proxy adapters can reuse it WITHOUT depending on this sibling adapter
// (the no-adapter→adapter dependency rule). Plugin call sites keep importing from here unchanged.
export { loadCatalog, loadInstructions, type LoadedCatalog } from "@skillforge/core";
