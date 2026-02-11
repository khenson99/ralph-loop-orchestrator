import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
type AjvCtor = new (options: { allErrors: boolean; strict: boolean }) => {
  compile: (schema: object) => {
    (data: unknown): boolean;
    errors?: unknown;
  };
};

const Ajv2020 = require('ajv/dist/2020').default as AjvCtor;

const statePath = path.resolve(process.cwd(), '.ralph-team/team-state.json');
const schemaPath = path.resolve(process.cwd(), 'src/schemas/ralph-team-state.schema.json');

async function main() {
  const [stateRaw, schemaRaw] = await Promise.all([
    fs.readFile(statePath, 'utf8'),
    fs.readFile(schemaPath, 'utf8'),
  ]);

  const state = JSON.parse(stateRaw) as unknown;
  const schema = JSON.parse(schemaRaw) as object;

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  const valid = validate(state);
  if (!valid) {
    console.error('Invalid .ralph-team/team-state.json');
    console.error(validate.errors);
    process.exit(1);
  }

  console.log('State file is valid');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
