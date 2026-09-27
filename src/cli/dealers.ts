import type { Ctx } from "../context.js";
/** `openwop dealers ...` — STUB (being filled in). */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from "./resourceCommands.js";

export const DEALERS_SPECS: CommandSpec[] = [];

export const DEALERS_HELP = buildGroupHelp("dealers", "TODO", DEALERS_SPECS);

export async function runDealers(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, "dealers", DEALERS_HELP, DEALERS_SPECS, argv);
}
