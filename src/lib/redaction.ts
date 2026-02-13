const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, replacement: '[REDACTED_TOKEN]' },
  { pattern: /\bsk-ant-[A-Za-z0-9\-_]{16,}\b/g, replacement: '[REDACTED_TOKEN]' },
  { pattern: /\bsk-[A-Za-z0-9\-_]{16,}\b/g, replacement: '[REDACTED_TOKEN]' },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED_TOKEN]',
  },
];

const KEY_VALUE_SECRET_PATTERN =
  /\b(api[_-]?key|access[_-]?token|token|secret|password)\b\s*([:=])\s*(['"]?)([^\s'",]+)\3/gi;
const SECRET_KEY_PATTERN = /\b(api[_-]?key|access[_-]?token|token|secret|password)\b/i;

export function redactSecretsInText(text: string): string {
  let value = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    value = value.replace(pattern, replacement);
  }

  value = value.replace(KEY_VALUE_SECRET_PATTERN, (_match, key: string, operator: string) => {
    return `${key}${operator}[REDACTED]`;
  });

  return value;
}

export function redactSecrets<T>(value: T): T {
  return redactSecretsInternal(value, new WeakSet()) as T;
}

function redactSecretsInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactSecretsInText(value);
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsInternal(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);

    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key) && (typeof child === 'string' || typeof child === 'number')) {
        output[key] = '[REDACTED]';
        continue;
      }

      output[key] = redactSecretsInternal(child, seen);
    }
    return output;
  }

  return value;
}
