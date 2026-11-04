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
  /** The host advertises the v2 conformance seams profile (memoized by `negotiateMajor`; major 2 only). */
  seamsV2?: boolean;
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
  relayDeliver?: (egress: { channel?: string; conversationId: string; text: string }) => unknown;
  /** Test seam: inject a channel plugin for the relay receive loop. */
  relayPlugin?: ChannelPlugin;
  /**
   * The server address the user passed explicitly (`--base-url` / OPENWOP_BASE_URL),
   * undefined when it came from config or the default. `relay start` refuses one
   * that differs from the address the relay was activated against (ADR 1043 D7).
   */
  explicitBaseUrl?: string | undefined;
  /** Test seams for `openwop relay` (setup consent, service install, the bridge loop). */
  relaySeams?: {
    isTTY?: boolean;
    prompt?: (question: string) => Promise<string>;
    runCommand?: (argv: string[]) => { status: number | null; stdout?: string; stderr?: string };
    platform?: string;
    home?: string;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
  };
}
