/** The CLI execution context threaded through every command handler. */

import type { ChannelPlugin } from './channels/types.js';

export interface CliIo {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

export interface Ctx {
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  fetchImpl: typeof fetch;
  baseUrl: string;
  apiKey?: string | undefined;
  /** Protocol major negotiated for this process (memoized by `negotiateMajor`; see src/protocol.ts). */
  protocolMajor?: 1 | 2;
  /** Active config profile (`--profile` / OPENWOP_PROFILE); undefined = the default profile. */
  profile?: string | undefined;
  json: boolean;
  quiet?: boolean;
  verbose?: boolean;
  /** Repo root when invoked from a checkout (null when not found). */
  repoRoot?: string | null;
  /** Test seam: per-turn stdin reader for `openwop chat` (null on EOF). */
  readTurn?: (prompt: string) => Promise<string | null>;
  /** Test seam: inject outbound delivery for `openwop relay start`. */
  relayDeliver?: (egress: { channel: string; conversationId: string; text: string }) => void | Promise<void>;
  /** Test seam: inject a channel plugin for the relay receive loop. */
  relayPlugin?: ChannelPlugin;
}
