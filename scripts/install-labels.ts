import { GitHubClient } from '../src/integrations/github/client.js';

type Args = {
  owner: string;
  repo: string;
  appId?: string;
  installationId?: number;
  privateKey?: string;
  token?: string;
};

function getArg(name: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === `--${name}`);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function loadArgs(): Args {
  const owner = getArg('owner') ?? process.env.GITHUB_TARGET_OWNER;
  const repo = getArg('repo') ?? process.env.GITHUB_TARGET_REPO;
  const appId = getArg('app-id') ?? process.env.GITHUB_APP_ID;
  const installationIdRaw = getArg('installation-id') ?? process.env.GITHUB_APP_INSTALLATION_ID;
  const privateKeyRaw = getArg('private-key') ?? process.env.GITHUB_APP_PRIVATE_KEY;
  const token = getArg('token') ?? process.env.GITHUB_TOKEN;

  if (!owner || !repo) {
    throw new Error(
      'Missing required target repo. Provide --owner and --repo or set GITHUB_TARGET_OWNER/GITHUB_TARGET_REPO.',
    );
  }

  if (!token && (!appId || !installationIdRaw || !privateKeyRaw)) {
    throw new Error(
      'Missing GitHub auth config. Provide --token or --app-id --installation-id --private-key (or env vars).',
    );
  }

  return {
    owner,
    repo,
    token,
    appId,
    installationId: installationIdRaw ? Number(installationIdRaw) : undefined,
    privateKey: privateKeyRaw?.replace(/\\n/g, '\n'),
  };
}

async function main() {
  const args = loadArgs();
  const client = new GitHubClient({
    webhookSecret: 'unused',
    token: args.token,
    appId: args.appId,
    appPrivateKey: args.privateKey,
    installationId: args.installationId,
    targetOwner: args.owner,
    targetRepo: args.repo,
    baseBranch: 'main',
  });

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
