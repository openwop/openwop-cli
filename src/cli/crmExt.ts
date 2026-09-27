/** CRM extension specs — STUB (being filled in). Concatenates CRM_ORG_SPECS (crmOrg.ts). */
import type { CommandSpec } from './resourceCommands.js';
import { CRM_ORG_SPECS, CRM_ORG_INTRO } from './crmOrg.js';

const CRM_TENANT_SPECS: CommandSpec[] = [];
const CRM_TENANT_INTRO = '';

export const CRM_EXT_SPECS: CommandSpec[] = [...CRM_TENANT_SPECS, ...CRM_ORG_SPECS];
export const CRM_EXT_INTRO = [CRM_TENANT_INTRO, CRM_ORG_INTRO].filter(Boolean).join('\n\n');
