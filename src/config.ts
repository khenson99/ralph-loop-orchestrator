import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.string().min(1),

  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_APP_INSTALLATION_ID: z.string().min(1),
  GITHUB_TARGET_OWNER: z.string().min(1),
  GITHUB_TARGET_REPO: z.string().min(1),
  GITHUB_BASE_BRANCH: z.string().min(1).default('main'),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default('gpt-5.3-codex'),

  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-4-6'),

  AUTO_MERGE_ENABLED: z
    .string()
    .optional()
    .transform((value) => (value ?? 'true').toLowerCase() === 'true'),
  REQUIRED_CHECKS: z.string().optional().default(''),

  OTEL_ENABLED: z
    .string()
    .optional()
    .transform((value) => (value ?? 'true').toLowerCase() === 'true'),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  databaseUrl: string;
  github: {
    webhookSecret: string;
    appId: string;
    appPrivateKey: string;
    installationId: number;
    targetOwner: string;
    targetRepo: string;
    baseBranch: string;
  };
  openai: {
    apiKey: string;
    model: string;
  };
  anthropic: {
    apiKey: string;
    model: string;
  };
  autoMergeEnabled: boolean;
  requiredChecks: string[];
  otelEnabled: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    github: {
      webhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
      appId: parsed.GITHUB_APP_ID,
      appPrivateKey: parsed.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'),
      installationId: Number(parsed.GITHUB_APP_INSTALLATION_ID),
      targetOwner: parsed.GITHUB_TARGET_OWNER,
      targetRepo: parsed.GITHUB_TARGET_REPO,
      baseBranch: parsed.GITHUB_BASE_BRANCH,
    },
    openai: {
      apiKey: parsed.OPENAI_API_KEY,
      model: parsed.OPENAI_MODEL,
    },
    anthropic: {
      apiKey: parsed.ANTHROPIC_API_KEY,
      model: parsed.ANTHROPIC_MODEL,
    },
    autoMergeEnabled: parsed.AUTO_MERGE_ENABLED,
    requiredChecks: parsed.REQUIRED_CHECKS.split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
    otelEnabled: parsed.OTEL_ENABLED,
  };
}
