// The one secret redactor (src/redact.ts) — traversal here, policy at each caller.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactSecrets } from '../dist/cli.js';

describe('redactSecrets', () => {
  it('redacts secret-named values at any depth, keeps the rest, never mutates', () => {
    const input = { clientId: 'c1', clientSecret: 's', nested: [{ apiKey: 'k', name: 'n' }], token: { a: 1 } };
    const out = redactSecrets(input);
    assert.deepEqual(out, { clientId: 'c1', clientSecret: '[redacted]', nested: [{ apiKey: '[redacted]', name: 'n' }], token: '[redacted]' });
    assert.equal(input.clientSecret, 's', 'input untouched');
  });
  it('keep: a references-only container is shown but still recursed into', () => {
    const out = redactSecrets({ secretsToRebind: [{ ref: 'vault://x', password: 'p' }] }, { keep: /^secretsToRebind$/ });
    assert.deepEqual(out, { secretsToRebind: [{ ref: 'vault://x', password: '[redacted]' }] });
  });
  it('secret: a caller-supplied broader policy (auth: certificates, assertions) applies', () => {
    const auth = /secret|token|password|private[-_]?key|client[-_]?secret|api[-_]?key|credential|bearer|assertion|certificate|cert|pem/i;
    assert.deepEqual(redactSecrets({ signingCert: 'PEM', idpUrl: 'u' }, { secret: auth }), { signingCert: '[redacted]', idpUrl: 'u' });
    assert.deepEqual(redactSecrets({ signingCert: 'PEM' }), { signingCert: 'PEM' }, 'the base policy does not treat certificates as secrets');
  });
});
