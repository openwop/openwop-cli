/**
 * The ONE secret redactor (golden rule 3: secrets are references, never values).
 *
 * Recursively replaces the value of every field whose NAME matches `secret`
 * with `[redacted]`, returning a fresh structure (never mutates input). A field
 * whose name matches `keep` is not redacted but IS recursed into, so a
 * references-only container (portability's `secretsToRebind`) is shown while a
 * stray secret-named value inside it is still caught.
 *
 * Why one module: three surfaces (connections, portability, auth) each carried
 * a private copy, and they had already drifted — auth redacts
 * `bearer|assertion|cert|pem` too, portability has a references-only
 * exception. Those differences are POLICY, so each caller passes its own
 * pattern explicitly; only the traversal lives here. Generic in its input so a
 * caller reading fields off the result needs no cast.
 */

/** Field names whose values are credentials on every surface. `clientId` is deliberately not one. */
export const BASE_SECRET_KEY = /secret|token|password|private[-_]?key|client[-_]?secret|api[-_]?key|credential/i;

export interface RedactRules {
  /** Field-name pattern whose values are replaced. Default: BASE_SECRET_KEY. */
  secret?: RegExp;
  /** Field-name pattern that is never redacted (but is still recursed into). */
  keep?: RegExp;
}

export function redactSecrets<T>(value: T, rules: RedactRules = {}): T {
  const secret = rules.secret ?? BASE_SECRET_KEY;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        out[k] = secret.test(k) && !(rules.keep?.test(k) ?? false) ? '[redacted]' : walk(inner);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
