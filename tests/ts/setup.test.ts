import { test, expect } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dir, '../..');

test('setup vendors the skill, is idempotent, and works from the vendored copy', () => {
  const temp = mkdtempSync(join(tmpdir(), 'agentboard-setup-'));
  try {
    const bundle = join(temp, 'bundle');
    mkdirSync(join(bundle, 'scripts'), { recursive: true });
    for (const name of ['agentboard.ts', 'board.html', 'lib']) {
      cpSync(join(project, 'scripts', name), join(bundle, 'scripts', name), { recursive: true });
    }
    writeFileSync(join(bundle, 'SKILL.md'), '---\nname: agentboard\ndescription: Test board skill.\n---\nbody\n');
    writeFileSync(join(bundle, 'README.md'), 'contract');
    writeFileSync(join(bundle, 'CONTRIBUTING.md'), 'development only');
    for (const name of ['tests', 'docs', '.github']) {
      mkdirSync(join(bundle, name));
      writeFileSync(join(bundle, name, 'ignored'), 'ignored');
    }
    const makeRepo = (name: string) => {
      const repo = join(temp, name);
      mkdirSync(join(repo, '.git'), { recursive: true });
      writeFileSync(join(repo, 'AGENTS.md'), '# Rules\nkeep me');
      writeFileSync(join(repo, 'CLAUDE.md'), '# Claude\n');
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
      return repo;
    };
    const repo = makeRepo('bun-repo');
    const run = (args: string[]) => Bun.spawnSync(args, { cwd: project, stdout: 'pipe', stderr: 'pipe' });
    const cli = join(bundle, 'scripts', 'agentboard.ts');
    const first = run(['bun', cli, '--json', 'setup', repo]);
    expect(first.stderr.toString()).toBe('');
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout.toString()).changed).toContain('.agentboard/');
    const vendor = join(repo, '.agents', 'skills', 'agentboard');
    for (const path of ['SKILL.md', 'scripts/agentboard.ts', 'scripts/lib/setup.ts', 'scripts/board.html', 'README.md']) {
      expect(existsSync(join(vendor, path))).toBe(true);
    }
    for (const name of ['tests', 'docs', '.github']) expect(existsSync(join(vendor, name))).toBe(false);
    expect(existsSync(join(vendor, 'CONTRIBUTING.md'))).toBe(false);
    const pointer = '.claude/skills/agentboard/SKILL.md';
    expect(readFileSync(join(repo, pointer), 'utf8')).toContain('description: Test board skill.');
    const vendoredCli = join(vendor, 'scripts', 'agentboard.ts');
    const second = run(['bun', vendoredCli, '--json', 'setup', repo]);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout.toString()).changed).toEqual([]);
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('# Rules\nkeep me\n')).toBe(true);
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      expect(readFileSync(join(repo, path), 'utf8').split('<!-- agentboard:begin -->').length - 1).toBe(1);
      expect(readFileSync(join(repo, path), 'utf8').split('<!-- agentboard:end -->').length - 1).toBe(1);
    }
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules/\n/.agentboard.lock\n');
    const list = run(['bun', vendoredCli, '--root', repo, '--json', 'list']);
    expect(list.exitCode).toBe(0);
    expect(list.stdout.toString().trim()).toBe('[]');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('setup into the skill repository itself (dogfooding) does not nest copies or vendor agent settings', () => {
  const temp = mkdtempSync(join(tmpdir(), 'agentboard-self-'));
  try {
    const bundle = join(temp, 'bundle');
    mkdirSync(join(bundle, 'scripts'), { recursive: true });
    mkdirSync(join(bundle, '.git'));
    for (const name of ['agentboard.ts', 'board.html', 'lib']) {
      cpSync(join(project, 'scripts', name), join(bundle, 'scripts', name), { recursive: true });
    }
    writeFileSync(join(bundle, 'SKILL.md'), '---\nname: agentboard\ndescription: Test board skill.\n---\nbody\n');
    mkdirSync(join(bundle, '.claude'));
    writeFileSync(join(bundle, '.claude', 'settings.json'), '{}');
    const run = () => Bun.spawnSync(['bun', join(bundle, 'scripts', 'agentboard.ts'), '--json', 'setup', bundle],
      { cwd: project, stdout: 'pipe', stderr: 'pipe' });
    expect(run().exitCode).toBe(0);
    const second = run();
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout.toString()).changed).toEqual([]);
    const vendor = join(bundle, '.agents', 'skills', 'agentboard');
    expect(existsSync(join(vendor, 'scripts', 'agentboard.ts'))).toBe(true);
    expect(existsSync(join(vendor, '.agents'))).toBe(false);
    expect(existsSync(join(vendor, '.claude'))).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
