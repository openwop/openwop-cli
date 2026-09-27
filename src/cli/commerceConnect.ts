import type { Ctx } from "../context.js";
/** `openwop commerce-connect ...` — STUB (being filled in). */
import { buildGroupHelp, runResourceGroup, type CommandSpec } from "./resourceCommands.js";

export const COMMERCE_CONNECT_SPECS: CommandSpec[] = [];

export const COMMERCE_CONNECT_HELP = buildGroupHelp("commerce-connect", "TODO", COMMERCE_CONNECT_SPECS);

export async function runCommerceConnect(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, "commerce-connect", COMMERCE_CONNECT_HELP, COMMERCE_CONNECT_SPECS, argv);
}
