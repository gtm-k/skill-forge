// @skillforge/lmstudio/index — the LM Studio plugin ENTRY. `lms dev` calls main(context) once at load; we
// register the single prompt-preprocessor hook. Like promptPreprocessor.ts, this imports the real
// "@lmstudio/sdk" (present only inside the built plugin) and is type-checked against the ambient stub
// (lmstudio-sdk.d.ts). scripts/build-lmstudio-plugin.mjs copies this file into the plugin folder's src/.
import { type PluginContext } from "@lmstudio/sdk";
import { preprocess } from "./promptPreprocessor.ts";

export async function main(context: PluginContext): Promise<void> {
  context.withPromptPreprocessor(preprocess);
}
