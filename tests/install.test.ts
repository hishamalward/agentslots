import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
    expect(text(dir, 'AGENTS.md')).toContain('attach --worktree PATH');
    expect(text(dir, 'AGENTS.md')).toContain('never creates or removes Git branches/worktrees');
    expect(text(dir, 'scripts/agent-slots')).toContain('.agents/agentslots/scripts/agent-slots');
    expect(existsSync(path.join(dir, '.agents/agentslots/scripts/agent-slots'))).toBe(true);
    expect(existsSync(path.join(dir, '.agents/agentslots/scripts/agent-runtime.sh'))).toBe(true);
    expect(existsSync(path.join(dir, '.agents/agentslots/scripts/lib/agent-runtime.py'))).toBe(true);
    expect(existsSync(path.join(dir, '.agents/agentslots/docs/launchd-scheduling.md'))).toBe(true);
    expect(existsSync(path.join(dir, '.agents/agentslots/docs/launchd-sweep.plist.example'))).toBe(true);
    expect(text(dir, 'scripts/agent-slots')).toContain('.agents/agentslots/scripts/agent-slots');
    expect(existsSync(path.join(dir, '.agents/agentslots/scripts/agent-up.sh'))).toBe(true);
    expect(existsSync(path.join(dir, 'scripts/agent-up.sh'))).toBe(false);
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
    writeFileSync(path.join(dir, 'scripts/agent-slots'), original);
    expect(run(dir, '--apply').status).toBe(1);
    expect(text(dir, 'scripts/agent-slots')).toBe(original);
    expect(run(dir, '--adopt-existing', '--apply').status).toBe(0);
    expect(run(dir, '--uninstall').status).toBe(0);
    expect(existsSync(path.join(dir, '.agents/agentslots-install.json'))).toBe(true);
    expect(run(dir, '--uninstall', '--apply').status).toBe(0);
    expect(text(dir, 'scripts/agent-slots')).toBe(original);
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
    writeFileSync(path.join(dir, '.agents/agentslots/scripts/agent-runtime.sh'), 'my change\n');
    const manifest = text(dir, '.agents/agentslots-install.json');
    expect(run(dir, '--apply').status).toBe(1);
    expect(run(dir, '--uninstall', '--apply').status).toBe(1);
    expect(text(dir, '.agents/agentslots/scripts/agent-runtime.sh')).toBe('my change\n');
    expect(text(dir, '.agents/agentslots-install.json')).toBe(manifest);
  });

  it('migrates 0.2 manifests and restores adopted retired wrapper bytes', () => {
    const dir = fixture();
    expect(run(dir, '--apply').status).toBe(0);
    const manifestPath = path.join(dir, '.agents/agentslots-install.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const name = 'scripts/agent-up.sh';
    const bytes = '#!/bin/bash\necho old AgentSlots wrapper\n';
    const original = '#!/bin/bash\n# adopted project wrapper\n';
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), bytes, { mode: 0o755 });
    manifest.files[name] = {
      original: Buffer.from(original).toString('base64'),
      original_mode: 0o640,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    manifest.version = '0.2.0';
    manifest.revision = '77f18e544a36e610dd9bf120c112e07d5caf6463';
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const preview = run(dir);
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('write  scripts/agent-up.sh');
    expect(text(dir, name)).toBe(bytes);

    const update = run(dir, '--apply');
    expect(update.status, update.stderr).toBe(0);
    expect(text(dir, name)).toBe(original);
    expect(statSync(path.join(dir, name)).mode & 0o777).toBe(0o640);
    const migrated = JSON.parse(text(dir, '.agents/agentslots-install.json'));
    expect(migrated.version).toBe('0.3.0');
    expect(migrated.files[name]).toBeUndefined();
  });

  it('keeps refusing an edited retired 0.2 wrapper', () => {
    const dir = fixture();
    expect(run(dir, '--apply').status).toBe(0);
    const manifestPath = path.join(dir, '.agents/agentslots-install.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const name = 'scripts/agent-down.sh';
    const bytes = '#!/bin/bash\necho old AgentSlots wrapper\n';
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), bytes, { mode: 0o755 });
    manifest.files[name] = {
      original: null,
      original_mode: 0o644,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    manifest.version = '0.2.0';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const userEdit = '#!/bin/bash\n# user-owned change\n';
    writeFileSync(path.join(dir, name), userEdit);
    const before = text(dir, '.agents/agentslots-install.json');

    const preview = run(dir);
    expect(preview.status).toBe(1);
    expect(preview.stderr).toContain(`managed file changed: ${name}`);
    expect(text(dir, name)).toBe(userEdit);
    expect(text(dir, '.agents/agentslots-install.json')).toBe(before);
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

  it('previews the opted-in AgentKeel policy then restores its original bytes and mode', () => {
    const dir = fixture();
    const original = '{\r\n "protected_branches": ["main"], "writable": ["~/.npm"]\r\n}';
    writeFileSync(path.join(dir, 'agentkeel.json'), original);
    chmodSync(path.join(dir, 'agentkeel.json'), 0o600);
    expect(run(dir).stdout).toContain('agentkeel.json');
    expect(text(dir, 'agentkeel.json')).toBe(original);
    expect(run(dir, '--apply').status).toBe(0);
    const policy = JSON.parse(text(dir, 'agentkeel.json'));
    expect(policy).toEqual({ protected_branches: ['main'], writable: ['~/.npm', path.join(homedir(), '.agent-slots')] });
    expect(statSync(path.join(dir, 'agentkeel.json')).mode & 0o777).toBe(0o600);
    const installed = text(dir, 'agentkeel.json');
    expect(run(dir, '--apply').status).toBe(0);
    expect(text(dir, 'agentkeel.json')).toBe(installed);
    expect(run(dir, '--uninstall', '--apply').status).toBe(0);
    expect(text(dir, 'agentkeel.json')).toBe(original);
    expect(statSync(path.join(dir, 'agentkeel.json')).mode & 0o777).toBe(0o600);
  });

  it('does not create an AgentKeel policy or duplicate an existing coordination grant', () => {
    const dir = fixture();
    expect(run(dir, '--apply').status).toBe(0);
    expect(existsSync(path.join(dir, 'agentkeel.json'))).toBe(false);
    const original = '{"writable":["~/.agent-slots","~/.npm"],"protected_branches":["main"]}';
    writeFileSync(path.join(dir, 'agentkeel.json'), original);
    expect(run(dir, '--apply').status).toBe(0);
    expect(text(dir, 'agentkeel.json')).toBe(original);
    expect(run(dir, '--uninstall', '--apply').status).toBe(0);
    expect(text(dir, 'agentkeel.json')).toBe(original);
  });

  it('preserves user policy edits across update and uninstall', () => {
    const dir = fixture();
    writeFileSync(path.join(dir, 'agentkeel.json'), '{"protected_branches":["main"]}');
    expect(run(dir, '--apply').status).toBe(0);
    const edited = JSON.parse(text(dir, 'agentkeel.json'));
    edited.writable.push('~/.cache/project');
    edited.protected_branches.push('release');
    const userBytes = JSON.stringify(edited);
    writeFileSync(path.join(dir, 'agentkeel.json'), userBytes);
    expect(run(dir, '--apply').status).toBe(0);
    expect(run(dir, '--uninstall', '--apply').status).toBe(0);
    expect(text(dir, 'agentkeel.json')).toBe(userBytes);
  });

  it('keeps directly edited policies on uninstall', () => {
    const dir = fixture();
    writeFileSync(path.join(dir, 'agentkeel.json'), '{}');
    expect(run(dir, '--apply').status).toBe(0);
    const edited = '{"writable":["~/.cache/custom"]}';
    writeFileSync(path.join(dir, 'agentkeel.json'), edited);
    const result = run(dir, '--uninstall', '--apply');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('keep edited agentkeel.json');
    expect(text(dir, 'agentkeel.json')).toBe(edited);
  });

  it('requires an explicit custom lock parent without executing repository shell code', () => {
    const dir = fixture();
    const foreign = realpathSync(fixture());
    const coordination = path.join(foreign, 'coordination');
    const first = path.join(foreign, 'first');
    writeFileSync(path.join(dir, 'agentkeel.json'), '{"writable":["~/.npm"]}');
    writeFileSync(path.join(dir, '.agent-slots.conf'), `AGENT_SIM_LOCK="${coordination}/device.lock"\ntouch "${dir}/executed"\n`);
    expect(run(dir, '--apply').stderr).toContain('--coordination-dir');
    expect(existsSync(path.join(dir, 'executed'))).toBe(false);
    expect(existsSync(path.join(dir, '.agents'))).toBe(false);
    expect(run(dir, '--coordination-dir', first, '--apply').status).toBe(0);
    expect(run(dir, '--coordination-dir', coordination, '--apply').status).toBe(0);
    expect(JSON.parse(text(dir, 'agentkeel.json')).writable).toEqual(['~/.npm', coordination]);
    expect(existsSync(path.join(dir, 'executed'))).toBe(false);
    expect(run(dir, '--uninstall', '--apply').status).toBe(0);
    expect(text(dir, 'agentkeel.json')).toBe('{"writable":["~/.npm"]}');
  });

  it('refuses malformed policies, symlinks and protected coordination roots before writes', () => {
    for (const policy of ['{', '[]', '{"writable":null}', '{"writable":[7]}']) {
      const dir = fixture();
      writeFileSync(path.join(dir, 'agentkeel.json'), policy);
      expect(run(dir, '--apply').stderr).toContain('invalid agentkeel.json');
      expect(existsSync(path.join(dir, '.agents'))).toBe(false);
      expect(text(dir, 'agentkeel.json')).toBe(policy);
    }
    const dir = fixture();
    const foreign = realpathSync(fixture());
    writeFileSync(path.join(dir, 'agentkeel.json'), '{}');
    symlinkSync(foreign, path.join(foreign, 'linked'));
    for (const directory of [homedir(), '/', realpathSync(dir), path.join(realpathSync(dir), '.git'),
      path.join(homedir(), '.agentkeel'), path.join(foreign, 'linked', 'coordination')]) {
      expect(run(dir, '--coordination-dir', directory, '--apply').status).toBe(1);
      expect(existsSync(path.join(dir, '.agents'))).toBe(false);
      expect(text(dir, 'agentkeel.json')).toBe('{}');
    }
    rmSync(path.join(dir, 'agentkeel.json'));
    writeFileSync(path.join(foreign, 'agentkeel.json'), '{}');
    symlinkSync(path.join(foreign, 'agentkeel.json'), path.join(dir, 'agentkeel.json'));
    expect(run(dir, '--apply').stderr).toContain('refusing symlink');
    expect(text(foreign, 'agentkeel.json')).toBe('{}');
  });
});
