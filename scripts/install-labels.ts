import { loadConfig } from '../src/config.js';
import { GitHubClient } from '../src/integrations/github/client.js';

async function main() {
  const config = loadConfig();
  const client = new GitHubClient(config.github);

  await client.ensureLabels([
    { name: 'agent:backend', color: '5319E7', description: 'Assigned to Backend Engineer agent' },
    { name: 'agent:frontend', color: '1D76DB', description: 'Assigned to Frontend Engineer agent' },
    { name: 'agent:qa', color: 'A371F7', description: 'Assigned to QA agent' },
    {
      name: 'agent:design-system',
      color: '0E8A16',
      description: 'Assigned to Design System Enforcer agent',
    },
    { name: 'agent-ready', color: '1F883D', description: 'Issue has enough detail for autonomous execution' },
    { name: 'status:ready', color: 'FBCA04', description: 'Ready for autonomous execution' },
    { name: 'status:blocked', color: 'B60205', description: 'Blocked on dependency' },
  ]);

  console.log('Labels synced');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
