import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertWebhookTarget,
  explainError,
  signWebhook,
  verifyWebhook,
} from '../dist/diagnostics/explain.js';
import { FileSdkError, fail } from '../dist/errors/error.js';
import { runFfmpeg } from '../dist/processors/ffmpeg.js';

test('an explainer cannot change the error code and does not see the secret', async () => {
  const error = fail('FFMPEG_NOT_FOUND', {
    context: { secretAccessKey: 'topsecretvalue' },
  });
  let seen = '';
  const explained = await explainError(error, {
    async explain(report) {
      seen = JSON.stringify(report);
      return { suggestion: 'Install ffmpeg.' };
    },
  });
  assert.equal(explained.code, 'FFMPEG_NOT_FOUND');
  assert.equal(explained.suggestion, 'Install ffmpeg.');
  assert.equal(seen.includes('topsecretvalue'), false);
  const broken = await explainError(error, {
    async explain() {
      throw new Error('provider down');
    },
  });
  assert.equal(broken.code, 'FFMPEG_NOT_FOUND');
  assert.equal('suggestion' in broken, false);
});

test('webhook signatures reject replays and private production targets', () => {
  const body = '{"ok":true}';
  const now = 1_700_000_000;
  const header = signWebhook('signing-secret-value', body, now);
  assert.equal(verifyWebhook('signing-secret-value', body, header, now), true);
  assert.equal(
    verifyWebhook('signing-secret-value', body, header, now + 301),
    false,
  );
  assert.throws(
    () => assertWebhookTarget('http://127.0.0.1/hook', false),
    (error: unknown) => {
      return error instanceof FileSdkError && error.code === 'WEBHOOK_REJECTED';
    },
  );
  assert.throws(
    () => assertWebhookTarget('https://10.1.1.5/hook', false),
    (error: unknown) => {
      return error instanceof FileSdkError && error.code === 'WEBHOOK_REJECTED';
    },
  );
  assertWebhookTarget('http://127.0.0.1/hook', true);
});

test('a missing ffmpeg binary is a seeded, catalogued failure', async () => {
  await assert.rejects(
    runFfmpeg('definitely-not-a-filevora-ffmpeg', ['-version'], {
      timeoutMs: 1000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'FFMPEG_NOT_FOUND');
      assert.equal(
        error.resolution?.documentationPath,
        'docs/errors/FFMPEG_NOT_FOUND.md',
      );
      return true;
    },
  );
});
