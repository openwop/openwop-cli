import type { Ctx } from "../context.js";
/** `openwop territories ...` — STUB (being filled in). */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from "./resourceCommands.js";

export const TERRITORIES_SPECS: CommandSpec[] = [];

export const TERRITORIES_HELP = buildGroupHelp("territories", "TODO", TERRITORIES_SPECS);

export async function runTerritories(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, "territories", TERRITORIES_HELP, TERRITORIES_SPECS, argv);
}
