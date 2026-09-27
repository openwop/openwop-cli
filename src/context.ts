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
  /**
   * Origin to read event streams from, when the user chose one
   * (`--stream-base-url` > OPENWOP_STREAM_BASE_URL > config `host.streamBaseUrl`).
   * Absent → the host's advertised `streamBase` (validated), else `baseUrl`.
   * See `resolveStreamRequest` (src/protocol.ts).
   */
  streamBaseUrl?: string | undefined;
  apiKey?: string | undefined;
  /** Protocol major negotiated for this process (memoized by `negotiateMajor`; see src/protocol.ts). */
  protocolMajor?: 1 | 2;
  /**
   * The discovery document `negotiateMajor` read (requested with
   * `OpenWOP-Version: 2`) and the `OpenWOP-Version` the host answered with.
   * Absent under an `OPENWOP_PROTOCOL_MAJOR` pin or when discovery failed.
   */
  discovery?: { doc: unknown; servedVersion: string | undefined };
  /** Host-proprietary roots from discovery, `{ "/v1/host/<org>/": "/host/<org>/" }` (memoized by `negotiateMajor`). */
  hostRoots?: Readonly<Record<string, string>>;
  /** Advertised stream origin accepted from discovery (memoized by `negotiateMajor`); undefined = none/rejected. */
  discoveredStreamBase?: string | undefined;
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
