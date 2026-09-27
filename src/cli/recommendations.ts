import type { Ctx } from "../context.js";
/** `openwop recommendations ...` — STUB (being filled in). */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from "./resourceCommands.js";

export const RECOMMENDATIONS_SPECS: CommandSpec[] = [];

export const RECOMMENDATIONS_HELP = buildGroupHelp("recommendations", "TODO", RECOMMENDATIONS_SPECS);

export async function runRecommendations(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, "recommendations", RECOMMENDATIONS_HELP, RECOMMENDATIONS_SPECS, argv);
}
