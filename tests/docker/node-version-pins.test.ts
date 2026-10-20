/**
 * Component: Node version pins stay on one major (image stages, e2e images, CI) — Tests
 * Documentation: documentation/deployment/unified.md
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

// e2e/Dockerfile.test's build context leaves out .github/ and e2e/, so the containerized unit suite
// can't see these files. Skip them there with a reason, but never on GitHub Actions (full checkout).
// (Not CI: Dockerfile.test itself sets CI=true.)
const onGitHubActions = process.env.GITHUB_ACTIONS === 'true';

function nodeFroms(text: string): string[] {
  return [...text.matchAll(/^FROM\s+(node:\S+)/gm)].map((m) => m[1]);
}

function majorOf(image: string): number {
  const m = image.match(/^node:(\d+)[-@]/);
  if (!m) throw new Error(`no major version in ${image}`);
  return Number(m[1]);
}

// The image's major is the reference every other pin must match.
const unifiedFroms = nodeFroms(read('dockerfile.unified'));
const imageMajor = majorOf(unifiedFroms[0] ?? '');

const PINNED_FILES: { file: string; majors: (text: string) => number[]; digest: boolean }[] = [
  { file: 'e2e/Dockerfile.test', majors: (t) => nodeFroms(t).map(majorOf), digest: true },
  { file: 'e2e/fake-arr/Dockerfile', majors: (t) => nodeFroms(t).map(majorOf), digest: true },
  ...['.github/workflows/pr-ci.yml', '.github/workflows/run-tests.yml'].map((file) => ({
    file,
    majors: (t: string) => [...t.matchAll(/node-version:\s*['"]?(\d+)/g)].map((m) => Number(m[1])),
    digest: false,
  })),
];

describe('Node version pins', () => {
  it('dockerfile.unified: base, builder and prisma-cli all use the same node:<major>-bookworm tag', () => {
    expect(unifiedFroms).toHaveLength(3);
    expect(new Set(unifiedFroms).size).toBe(1);
    expect(unifiedFroms[0]).toMatch(/^node:\d+-bookworm$/);
    const text = read('dockerfile.unified');
    for (const stage of ['base', 'builder', 'prisma-cli']) {
      expect(text).toMatch(new RegExp(`^FROM ${unifiedFroms[0]} AS ${stage}$`, 'm'));
    }
  });

  for (const { file, majors, digest } of PINNED_FILES) {
    it(`${file} uses Node ${imageMajor}`, ({ skip }) => {
      if (!fs.existsSync(path.join(root, file))) {
        if (onGitHubActions) throw new Error(`${file} is missing on GitHub Actions`);
        const reason = `${file} is not in this checkout (e2e/Dockerfile.test build context); checked on GitHub Actions and host runs`;
        console.warn(`[node-version-pins] skipped: ${reason}`);
        skip(reason);
        return;
      }
      const text = read(file);
      const found = majors(text);
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((m) => m === imageMajor)).toBe(true);
      if (digest) {
        for (const from of nodeFroms(text)) expect(from).toMatch(/@sha256:[0-9a-f]{64}$/);
      }
    });
  }
});
