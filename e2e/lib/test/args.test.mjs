/**
 * Component: E2E runner argument/safety checks tests (node:test, host-run)
 * Documentation: documentation/testing/e2e-harness.md
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isInside, isReservedSlug, parseArgs, trustedRoot } from '../args.mjs';

test('isInside: path.relative based, no prefix confusion', () => {
  const root = path.resolve('/x/ReadMeABook-maint');
  assert.equal(isInside(root, path.join(root, '.claude', 'worktrees', 'a')), true);
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, path.resolve('/x/ReadMeABook')), false);
  assert.equal(isInside(path.resolve('/x/ReadMeABook'), root), false, 'ReadMeABook-maint is not inside ReadMeABook');
  assert.equal(isInside(root, path.resolve('/x/ReadMeABook-maint/../other')), false);
});

test('reserved slugs need --force-reserved', () => {
  assert.equal(isReservedSlug('preview'), true);
  assert.equal(isReservedSlug('t2-unit'), true);
  assert.equal(isReservedSlug('t2'), false);
  assert.throws(() => parseArgs(['down', '--slug', 'preview']), /reserved/);
  assert.equal(parseArgs(['down', '--slug', 'preview', '--force-reserved']).slug, 'preview');
  assert.throws(() => parseArgs(['--slug', 'x-unit', '--port', '3401', '--image', 'y']), /reserved/);
  assert.throws(() => parseArgs(['preview', '--slug', 'other', '--image', 'y']), /reserved slug "preview"/);
});

test('worktrees outside the trusted root are refused', () => {
  const outside = path.resolve(trustedRoot(), '..');
  assert.throws(() => parseArgs(['--slug', 'x', '--port', '3401', '--worktree', outside]), /outside/);
});

test('tainted-mode flag combinations', () => {
  assert.throws(() => parseArgs(['--slug', 'x', '--port', '3401', '--image', 'y', '--tainted']), /--tainted applies/);
  assert.throws(() => parseArgs(['--slug', 'x', '--port', '3401', '--image', 'y', '--pr-dockerfile']), /only applies with --tainted/);
  assert.throws(() => parseArgs(['--slug', 'x', '--port', '3400', '--image', 'y']), /3401-3499/);
});
