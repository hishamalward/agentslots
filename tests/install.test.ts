import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const temporary: string[] = [];
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentslots-install-'));
  temporary.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}
function run(dir: string, ...args: string[]) {
  return spawnSync('python3', [path.join(root, 'install.py'), '--repo', dir, ...args], { encoding: 'utf8' });
}
const text = (dir: string, file: string) => readFileSync(path.join(dir, file), 'utf8');
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('pinned runtime installer', () => {
  it('previews without creating configuration, wrappers or records', () => {
    const dir = fixture();
    expect(run(dir).status).toBe(0);
    expect(existsSync(path.join(dir, '.agents'))).toBe(false);
    expect(existsSync(path.join(dir, 'AGENTS.md'))).toBe(false);
  });

  it('installs wrappers and one instruction block, preserving project configuration', () => {
    const dir = fixture();
    writeFileSync(path.join(dir, '.agent-slots.conf'), 'AGENT_PROJECT_SLUG=custom\n');
    writeFileSync(path.join(dir, 'AGENTS.md'), '# Existing instructions\n');
    expect(run(dir, '--apply').status).toBe(0);
    expect(text(dir, '.agent-slots.conf')).toBe('AGENT_PROJECT_SLUG=custom\n');
    expect(text(dir, 'AGENTS.md')).toContain('# Existing instructions');
    expect(text(dir, 'scripts/agent-up.sh')).toContain('.agents/agentslots/scripts/agent-up.sh');
    expect(existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(path.join(dir, '.agents/agentslots/scripts/queue-isolation-check.mjs'))).toBe(true);
    const first = text(dir, '.agents/agentslots-install.json');
    expect(run(dir, '--apply').status).toBe(0);
    expect(text(dir, '.agents/agentslots-install.json')).toBe(first);
    expect(text(dir, 'AGENTS.md').match(/<!-- agentslots:start -->/g)).toHaveLength(1);
    expect(JSON.parse(first).revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it('requires explicit adoption and restores original entry points byte for byte', () => {
    const dir = fixture();
    mkdirSync(path.join(dir, 'scripts'));
    const original = '#!/bin/bash\r\necho original';
    writeFileSync(path.join(dir, 'scripts/agent-up.sh'), original);
    expect(run(dir, '--apply').status).toBe(1);
    expect(text(dir, 'scripts/agent-up.sh')).toBe(original);
    expect(run(dir, '--adopt-existing', '--apply').status).toBe(0);
    expect(run(dir, '--uninstall').status).toBe(0);
    expect(existsSync(path.join(dir, '.agents/agentslots-install.json'))).toBe(true);
    expect(run(dir, '--uninstall', '--apply').status).toBe(0);
    expect(text(dir, 'scripts/agent-up.sh')).toBe(original);
    expect(existsSync(path.join(dir, '.agents/agentslots'))).toBe(false);
  });

  it('restores untouched AGENTS with blank lines, CRLF and no final newline', () => {
    const dir = fixture();
    const original = '\r\n# Rules\r\n\r\nKeep this';
    writeFileSync(path.join(dir, 'AGENTS.md'), original);
    expect(run(dir, '--apply').status).toBe(0);
    expect(run(dir, '--uninstall', '--apply').status).toBe(0);
    expect(text(dir, 'AGENTS.md')).toBe(original);
  });

  it('preserves user instructions and configuration through update then uninstall', () => {
    const dir = fixture();
    expect(run(dir, '--apply').status).toBe(0);
    writeFileSync(path.join(dir, 'AGENTS.md'), text(dir, 'AGENTS.md') + '\nMy new rule\n');
    writeFileSync(path.join(dir, '.agent-slots.conf'), 'AGENT_PROJECT_SLUG=mine\n');
    expect(run(dir, '--apply').status).toBe(0);
    expect(run(dir, '--uninstall', '--apply').status).toBe(0);
    expect(text(dir, 'AGENTS.md')).toContain('My new rule');
    expect(text(dir, 'AGENTS.md')).not.toContain('agentslots:start');
    expect(text(dir, '.agent-slots.conf')).toBe('AGENT_PROJECT_SLUG=mine\n');
  });

  it('refuses modified managed files without partially updating anything', () => {
    const dir = fixture();
    expect(run(dir, '--apply').status).toBe(0);
    writeFileSync(path.join(dir, '.agents/agentslots/scripts/agent-up.sh'), 'my change\n');
    const manifest = text(dir, '.agents/agentslots-install.json');
    expect(run(dir, '--apply').status).toBe(1);
    expect(run(dir, '--uninstall', '--apply').status).toBe(1);
    expect(text(dir, '.agents/agentslots/scripts/agent-up.sh')).toBe('my change\n');
    expect(text(dir, '.agents/agentslots-install.json')).toBe(manifest);
  });

  it('refuses symlinks in destination parents without writing through them', () => {
    const dir = fixture();
    const foreign = fixture();
    symlinkSync(foreign, path.join(dir, '.agents'));
    expect(run(dir, '--apply').status).toBe(1);
    expect(existsSync(path.join(foreign, 'agentslots'))).toBe(false);
    expect(existsSync(path.join(dir, 'scripts'))).toBe(false);
  });

  it('rejects a manifest path that could restore an unrelated file', () => {
    const dir = fixture();
    expect(run(dir, '--apply').status).toBe(0);
    const file = path.join(dir, '.agents/agentslots-install.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.files['README.md'] = { original: null, sha256: 'x' };
    writeFileSync(file, JSON.stringify(manifest));
    writeFileSync(path.join(dir, 'README.md'), 'unrelated');
    expect(run(dir, '--uninstall', '--apply').status).toBe(1);
    expect(text(dir, 'README.md')).toBe('unrelated');
  });
});
