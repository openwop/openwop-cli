import type { Ctx } from "../context.js";
/** `openwop commissions ...` — STUB (being filled in). */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from "./resourceCommands.js";

export const COMMISSIONS_SPECS: CommandSpec[] = [];

export const COMMISSIONS_HELP = buildGroupHelp("commissions", "TODO", COMMISSIONS_SPECS);

export async function runCommissions(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, "commissions", COMMISSIONS_HELP, COMMISSIONS_SPECS, argv);
}
