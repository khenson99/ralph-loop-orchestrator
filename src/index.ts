import { loadConfig } from './config.js';
import { buildServer } from './api/server.js';
import { ClaudeAdapter } from './integrations/anthropic/claude.js';
import { GitHubClient } from './integrations/github/client.js';
import { CodexAdapter } from './integrations/openai/codex.js';
import { createLogger } from './lib/logger.js';
import { startTelemetry, stopTelemetry } from './lib/telemetry.js';
import { OrchestratorService } from './orchestrator/service.js';
import { DatabaseClient } from './state/db.js';
import { WorkflowRepository } from './state/repository.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  await startTelemetry(config.otelEnabled);

  const dbClient = new DatabaseClient(config.databaseUrl);
  const repo = new WorkflowRepository(dbClient);
  const github = new GitHubClient(config.github);
  const codex = new CodexAdapter(config.openai);
  const claude = new ClaudeAdapter(config.anthropic);

  const orchestrator = new OrchestratorService(repo, github, codex, claude, config, logger);

  const server = buildServer({
    config,
    dbClient,
    workflowRepo: repo,
    orchestrator,
    logger,
  });

  const close = async () => {
    logger.info('Shutting down server...');
    await server.close();
    await dbClient.close();
    await stopTelemetry();
    process.exit(0);
  };

  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  await server.listen({
    host: '0.0.0.0',
    port: config.port,
  });

  logger.info({ port: config.port }, 'ralph-loop-orchestrator started');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
