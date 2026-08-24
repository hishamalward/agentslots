import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '..');

function filesBelow(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === '.git' || entry === 'node_modules') return [];
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? filesBelow(full) : [full];
  });
}

describe('release surface', () => {
  it('has no broken local Markdown links', () => {
    const broken: string[] = [];
    for (const file of filesBelow(REPO).filter((candidate) => candidate.endsWith('.md'))) {
      const markdown = readFileSync(file, 'utf8');
      for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1].split('#')[0];
        if (!target || /^(https?:|mailto:)/.test(target)) continue;
        const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
        if (!existsSync(resolved)) broken.push(`${path.relative(REPO, file)} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('preserves executable modes for every command-line script', () => {
    const scripts = filesBelow(path.join(REPO, 'scripts'))
      .filter((file) => file.endsWith('.sh') || file.endsWith('.mjs'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(statSync(script).mode & 0o111, script).not.toBe(0);
  });

  it('keeps source-project literals out of executable core code', () => {
    const core = filesBelow(path.join(REPO, 'scripts'))
      .filter((file) => file.endsWith('.sh'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(core).not.toMatch(/music_analytics|apps\/web|apps\/mobile|npx next|npx expo|npx prisma|SPOTIFY|GOOGLE/);
  });

  it('keeps source-project names out of documentation', () => {
    const docs = filesBelow(REPO)
      .filter((file) => file.endsWith('.md'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(docs).not.toMatch(/music_analytics|ma-accept|play-history|poll-history|poll-trigger|SPOTIFY/);
  });
});
