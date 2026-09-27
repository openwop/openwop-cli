import type { Ctx } from "../context.js";
/** `openwop commerce ...` — STUB (being filled in). */
import { COMMERCE_UCP_SPECS, COMMERCE_UCP_INTRO } from "./commerceUcp.js";
import { buildGroupHelp, runResourceGroup, type CommandSpec } from "./resourceCommands.js";

const COMMERCE_CORE_SPECS: CommandSpec[] = [];

export const COMMERCE_SPECS: CommandSpec[] = [...COMMERCE_CORE_SPECS, ...COMMERCE_UCP_SPECS];

export const COMMERCE_HELP = buildGroupHelp("commerce", ["TODO", COMMERCE_UCP_INTRO].filter(Boolean).join("\n\n"), COMMERCE_SPECS);

export async function runCommerce(ctx: Ctx, argv: string[]) {
  return runResourceGroup(ctx, "commerce", COMMERCE_HELP, COMMERCE_SPECS, argv);
}
