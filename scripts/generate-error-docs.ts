import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ERROR_CATALOG } from '../packages/filevora/src/errors/catalog.ts';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'docs/errors');
mkdirSync(dir, { recursive: true });

for (const [code, spec] of Object.entries(ERROR_CATALOG)) {
  const actions = spec.resolution.actions
    .map(
      (item) =>
        `- ${item.id}: ${item.description}${item.command ? ` (\`${item.command}\`)` : ''}`,
    )
    .join('\n');
  const verify = spec.resolution.verifyCommand
    ? `\nVerify: \`${spec.resolution.verifyCommand}\`\n`
    : '';
  const body = `# ${code}

${spec.message}

Category: \`${spec.category}\`. HTTP ${spec.httpStatus}. Retryable: ${spec.retryable}.

${spec.resolution.explanation}

${actions}
${verify}
`;
  writeFileSync(path.join(dir, `${code}.md`), body);
}

process.stdout.write(
  `wrote ${Object.keys(ERROR_CATALOG).length} error notes\n`,
);
