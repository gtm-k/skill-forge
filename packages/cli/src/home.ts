// @skillforge/cli/home — re-export of the shared home resolution + layout (Wave C / D3).
//
// The resolution precedence (override → $SKILLFORGE_HOME → <os.homedir>/.skillforge) and the layout names
// now live ONCE in @skillforge/core/home; this module re-exports them so the CLI's `from "./home.ts"` import
// sites (add.ts, bin.ts, manifest.ts) are unchanged. HOME stays INJECTABLE everywhere (every accessor takes
// an explicit home; skillforgeHome takes an optional override) so tests use a throwaway temp dir.
export { skillforgeHome, sourcesPath, manifestPath, SOURCES_DIR_NAME, MANIFEST_FILE_NAME } from "@skillforge/core";
