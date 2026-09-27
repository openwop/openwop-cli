import type { Ctx } from "../context.js";
/** `openwop commerce ...` — STUB (being filled in). */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from "./resourceCommands.js";

export const COMMERCE_SPECS: CommandSpec[] = [];

export const COMMERCE_HELP = buildGroupHelp("commerce", "TODO", COMMERCE_SPECS);

export async function runCommerce(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, "commerce", COMMERCE_HELP, COMMERCE_SPECS, argv);
}
