import type { Ctx } from "../context.js";
/** `openwop sales-maps ...` — STUB (being filled in). */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from "./resourceCommands.js";

export const SALES_MAPS_SPECS: CommandSpec[] = [];

export const SALES_MAPS_HELP = buildGroupHelp("sales-maps", "TODO", SALES_MAPS_SPECS);

export async function runSalesMaps(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, "sales-maps", SALES_MAPS_HELP, SALES_MAPS_SPECS, argv);
}
