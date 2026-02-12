import { describe, expect, it } from 'vitest';

import { redactSecrets, redactSecretsInText } from '../src/lib/redaction.js';

describe('redaction', () => {
  it('redacts common token formats from text', () => {
    const input =
      'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 api_key=sk-abcdefghijklmnopqrstuvwxyz123456';

    const output = redactSecretsInText(input);

    expect(output).toContain('token=[REDACTED]');
    expect(output).toContain('api_key=[REDACTED]');
    expect(output).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
    expect(output).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });

  it('redacts nested object values recursively', () => {
    const input = {
      headers: {
        authorization: 'Bearer sk-ant-abcdefghijklmnopqrstuvwxyz123456',
      },
      nested: [{ password: 'supersecretvalue' }],
    };

    const output = redactSecrets(input);

    expect(output).toEqual({
      headers: {
        authorization: 'Bearer [REDACTED_TOKEN]',
      },
      nested: [{ password: '[REDACTED]' }],
    });
  });
});
