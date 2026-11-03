/**
 * Guard: no secret reaches the argv of a process spawned from TypeScript or
 * JavaScript. The scanner and the reasoning live in
 * ./spawn-argv-scan.ts; this file is the assertion plus the cases that pin it.
 *
 * THE UNIVERSE IS `git ls-files`, not a filesystem glob. The tracked set is the
 * same on every machine for a given commit, so the verdict describes the code
 * and never the machine — CI is one slow runner, and a false positive there
 * blocks every push. It is also repo-wide: a spawning file at the root or in a
 * new top-level directory cannot opt out by living outside a root list.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSecretName, scanSource, shellExpansions, spawnCalls } from './spawn-argv-scan.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PATTERNS = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'];

let tracked: string[] | undefined;
function trackedSources(): string[] {
  tracked ??= execFileSync('git', ['ls-files', '-z', '--', ...PATTERNS], { cwd: REPO, encoding: 'utf-8' })
    .split('\0')
    .filter(Boolean);
  return tracked;
}

const read = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf-8');
const IMPORT = "import { spawn, spawnSync, execFile, execFileSync, exec, execSync, fork } from 'node:child_process';\n";
const scan = (body: string): string[] => scanSource(IMPORT + body).map((f) => f.reason);

describe('the guard', () => {
  it('no tracked source passes a secret to a spawned argv', () => {
    const failures = trackedSources().flatMap((rel) =>
      scanSource(read(rel), rel).map((f) => `${rel}:${f.line}: ${f.reason}`),
    );
    expect(failures).toEqual([]);
  });

  it('scans the whole tracked tree, root files and JavaScript included', () => {
    const files = trackedSources();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('drizzle.config.ts');
    expect(files).toContain('scripts/spike/embed-parity.mjs');
  });

  it('recognises the real call sites — a scanner that sees none passes everything', () => {
    // Per file, so one import shape breaking cannot hide behind another's count.
    const seen = trackedSources().filter((rel) => spawnCalls(read(rel), rel).length > 0);
    expect(seen).toEqual(
      expect.arrayContaining([
        'scripts/ranking-guard.ts',
        'scripts/snapshot-golden-corpus.ts',
        'tests/env-load-order.test.ts',
        'tests/integration/thermal-lookup.test.ts',
        'tests/ranking-guard-digest.test.ts',
        'tests/spawn-argv-guard.test.ts',
      ]),
    );
  });

  it.each([
    ['tests/integration/thermal-lookup.test.ts', "'--input-type=module', '-e', script"],
    ['tests/env-load-order.test.ts', "join(repoRoot, 'tests/fixtures/env-load-order-probe.ts')"],
  ])('catches a leak injected into the real call site in %s', (rel, anchor) => {
    const src = read(rel);
    expect(src, 'anchor moved — point this test at the current argv').toContain(anchor);
    expect(scanSource(src, rel)).toEqual([]);
    const leaked = src.replace(anchor, `${anchor}, process.env.DATABASE_URL!`);
    expect(scanSource(leaked, rel).map((f) => f.reason).join('\n')).toContain('DATABASE_URL');
  });
});

describe('flags a secret in argv', () => {
  it.each([
    "spawn('psql', [process.env.DATABASE_URL!]);",
    "spawnSync('psql', ['-d', dsn]);",
    "execFileSync('curl', ['-H', `Authorization: token ${token}`]);",
    "execSync(`psql ${DATABASE_URL} -c 'select 1'`);",
    "exec('psql ' + dbPassword);",
    "fork('child.js', [apiKey]);",
    "spawn('psql', [process.env['DATABASE_URL']!]);",
    "execFileSync<string>('psql', [secretKey]);",
    "execFileSync<Array<string>>('psql', [authToken]);",
    "spawnSync('psql', ['-d', ...dsnArgs]);",
    "spawnSync(\n  'psql',\n  [\n    '-d',\n    connectionString,\n  ],\n  { stdio: 'inherit' },\n);",
    // taint: declared, destructured (default, nested), reassigned, second declarator
    "const url = process.env.DATABASE_URL;\nspawn('psql', [url]);",
    "const { DATABASE_URL: u } = process.env;\nspawn('psql', [u!]);",
    "const { DATABASE_URL: u = '' } = process.env;\nspawn('psql', [u]);",
    "const { env: { DATABASE_URL: u } } = process;\nspawn('psql', [u!]);",
    "let u: string;\nu = process.env.PGPASSWORD!;\nspawn('psql', [u]);",
    "const a = 1, b = dsn;\nspawn('psql', [b]);",
    "const c = b;\nconst b = dsn;\nspawn('psql', [c]);",
    "const a = process.env.PGPASSWORD;\nconst b = `x${a}`;\nexecFile('x', [b]);",
    // argv built up after its declaration
    "const args = ['-d'];\nif (x) args.push(process.env.DATABASE_URL!);\nspawnSync('psql', args);",
    "const args = ['-d', ''];\nargs[1] = dsn;\nspawn('psql', args);",
    "let cmd = 'psql ';\ncmd += dsn;\nexecSync(cmd);",
    // a computed env key hides the name from any name check, however it is reached
    "const KEY = 'DATABASE_URL';\nspawn('psql', [process.env[KEY]!]);",
    "const e = process.env;\nspawn('psql', [e[K]!]);",
    "const { [K]: v } = process.env;\nspawn('psql', [v!]);",
    // options fields that land in argv anyway
    "spawn('psql', [], { argv0: process.env.DATABASE_URL! });",
    "fork('c.js', [], { execArgv: ['--x', dsn] });",
    "const o = { execArgv: [dsn] };\nfork('c.js', [], o);",
    // a same-file function, getter, method or class field hands the secret back
    "function conn() { return process.env.DATABASE_URL!; }\nspawn('psql', [conn()]);",
    "const conn = () => dsn;\nspawn('psql', [conn()]);",
    "class C { get url() { return dsn; } run() { spawn('psql', [this.url]); } }",
    "class C { u = process.env.DATABASE_URL!; run() { spawn('psql', [this.u]); } }",
    "class C { u = ''; run() { this.u = dsn; spawn('psql', [this.u]); } }",
    // bindings without a plain initializer
    "for (const u of [dsn]) spawn('psql', [u]);",
    "[dsn].forEach((u) => spawn('psql', [u]));",
    "function f(u = dsn) { spawn('psql', [u]); }",
    "const { a = dsn } = obj;\nspawn('x', [a]);",
    "let u: string | undefined;\n({ DATABASE_URL: u } = process.env);\nspawn('x', [u!]);",
    "const o = { a: dsn };\nlet a;\n({ a } = o);\nspawn('x', [a]);",
    // mutation through an alias, a bracket, a non-null, Object.assign; every mutator and op
    "const args = ['-d'];\nconst al = args;\nal.push(dsn);\nspawn('psql', args);",
    "const args: string[] = [];\nObject.assign(args, [dsn]);\nspawn('psql', args);",
    "const args = ['-d'];\nargs['push'](dsn);\nspawn('psql', args);",
    "const args = ['-d'];\nargs!.push(dsn);\nspawn('psql', args);",
    "const args = ['-d'];\nargs.unshift(dsn);\nspawn('psql', args);",
    "const args = ['-d'];\nargs.splice(0, 0, dsn);\nspawn('psql', args);",
    "let u = '';\nu ??= dsn;\nspawn('x', [u]);",
    "let u = '';\nu ||= dsn;\nspawn('x', [u]);",
    "let u = 'x';\nu &&= dsn;\nspawn('x', [u]);",
    "const args = ['-d'];\nlet al: string[] = [];\nal = args;\nal.push(dsn);\nspawn('psql', args);",
    // more writes: Map/Set, fill, a declaration-less for…of, reduce parameters
    "const m = new Map<string, string>();\nm.set('u', dsn);\nspawn('psql', [m.get('u')!]);",
    "const a = [''];\na.fill(dsn);\nspawn('psql', a);",
    "let u = '';\nfor (u of [dsn]) spawn('psql', [u]);",
    "[dsn].reduce((acc, v) => { spawn('psql', [v]); return acc; }, 0);",
    "[1].reduce((acc: string) => { spawn('psql', [acc]); return acc; }, dsn);",
    "[dsn, 'b'].reduce((acc, x) => { spawn('psql', [acc]); return acc + x; }, '');",
    // a string-keyed member write is a member write
    "process.env['X'] = dsn;\nspawn('psql', [process.env['X']!]);",
    "class C { u = ''; run() { this['u'] = dsn; spawn('psql', [this['u']]); } }",
    // a local container holds what is written into it
    "const o: Record<string, string> = {};\no.url = dsn;\nspawn('x', [JSON.stringify(o)]);",
    // execArgv behind a spread options bag
    "const base = { execArgv: [dsn] };\nfork('c.js', [], { ...base });",
  ])('%s', (body) => {
    expect(scan(body)).not.toEqual([]);
  });

  it.each([
    ["aliased", "import { execFile as run } from 'child_process';\nrun('psql', [dsn]);"],
    ["namespace", "import * as cp from 'node:child_process';\ncp.spawnSync('psql', [DATABASE_URL]);"],
    ["default", "import cp from 'child_process';\ncp.execSync(`psql ${dsn}`);"],
    ["default + named", "import cp, { spawn } from 'child_process';\nspawn('psql', [dsn]);"],
    ["comment in the list", "import {\n  execSync, // run } it\n  spawn,\n} from 'child_process';\nspawn('psql', [dsn]);"],
    ["element access", "import * as cp from 'child_process';\ncp['spawn']('psql', [dsn]);"],
    ["import = require", "import cp = require('child_process');\ncp.spawn('psql', [dsn]);"],
  ])('through a %s import', (_label, src) => {
    expect(scanSource(src)).not.toEqual([]);
  });

  it.each([
    // lexer traps the AST is immune to: a backtick in a regex, a comment or a string
    "function f(s: string) { return /`/.test(s); }\nspawn('psql', [dsn]);",
    "const r = /[/`]/;\nspawn('psql', [dsn]);",
    "/* a\n ` b */\nspawn('psql', [dsn]);",
    "spawn('x', ['a\\'', dsn]);",
    "let i = 0; i++ / 2;\nspawn('psql', [dsn]); 3 / 1;",
  ])('through lexical noise: %s', (body) => {
    expect(scan(body)).not.toEqual([]);
  });
});

describe('flags a secret the shell expands into argv', () => {
  it.each([
    "execSync('psql \"$DATABASE_URL\" -c \"select 1\"', { env });",
    "exec(`psql \\${PGPASSWORD} -c x`, { env });",
    "const cmd = 'psql \"$DATABASE_URL\"';\nexecSync(cmd, { env });",
    "spawn('sh', ['-c', 'psql \"$DATABASE_URL\"'], { env });",
    "spawn('/bin/bash', ['-c', 'curl -H \"Authorization: token $CODEBERG_TOKEN\" x'], { env });",
    "spawn('psql', ['\"$DATABASE_URL\"'], { env, shell: true });",
    "spawn('psql', ['\"$DATABASE_URL\"'], { env, 'shell': true });",
    "const o = { env, shell: true };\nspawn('psql', ['\"$DATABASE_URL\"'], o);",
    "spawn('bash', ['-lc', 'psql \"$DATABASE_URL\"'], { env });",
    "spawn('sh', ['-ec', 'psql \"$DATABASE_URL\"'], { env });",
    "spawn('/usr/bin/env', ['bash', '-c', 'psql \"$DATABASE_URL\"'], { env });",
    "spawn('env', ['-i', 'A=b', 'sh', '-c', 'psql \"$DATABASE_URL\"'], { env });",
    "spawn('sudo', ['-u', 'pg', 'sh', '-c', 'psql \"$DATABASE_URL\"'], { env });",
    "spawn('timeout', ['5', 'bash', '-c', 'psql \"$DATABASE_URL\"'], { env });",
    "spawn('fish', ['-c', 'psql \"$DATABASE_URL\"'], { env });",
    "const SH = 'bash';\nspawn(SH, ['-c', 'psql \"$DATABASE_URL\"'], { env });",
    // an escaped backslash before a substitution does not escape the $ after it
    "execSync(`echo \\\\${x}$DATABASE_URL`, { env });",
    "const base = { shell: true };\nspawn('psql', ['\"$DATABASE_URL\"'], { ...base, env });",
    "const a = ['-c', 'psql \"$DATABASE_URL\"'];\nspawn('sh', a, { env });",
    "function cmd() { return 'psql \"$DATABASE_URL\"'; }\nexecSync(cmd(), { env });",
    // quotes pair across template substitutions and + concatenation
    "execSync(`psql -c '${sql}' \"$DATABASE_URL\" -v 'X=1'`, { env });",
    "execSync(`a ${x} \"$DATABASE_URL\" ${y}`, { env });",
    "execSync('psql \"$' + 'DATABASE_URL\"', { env });",
    // an apostrophe inside double quotes is literal, not the start of a '…' span
    "execSync(\"echo \\\"don't\\\" \\\"$DATABASE_URL\\\" 'x'\", { env });",
  ])('%s', (body) => {
    expect(scan(body)).not.toEqual([]);
  });
});

describe('allows safe shapes', () => {
  it.each([
    "spawnSync('psql', ['-c', 'select 1'], { env: { ...process.env, DATABASE_URL } });",
    "const env = { ...process.env, DATABASE_URL: dsn };\nexecFileSync(process.execPath, ['x.ts'], { env });",
    "execFile('x', { env: { TOKEN: token } });",
    "spawn('tool', ['--password-file', '/etc/secret.txt']);",
    "spawn('tool', [\n  // DATABASE_URL arrives via env, never here\n  'x',\n]);",
    "execSync('git rev-parse --short HEAD', { cwd: '/repo' });",
    "execSync(`echo DATABASE_URL is read from env`, { env });",
    // sh leaves a single-quoted $NAME alone
    "execSync(\"echo '$DATABASE_URL' is literal\", { env });",
    // an argv string that merely contains $NAME, with no shell to expand it
    "spawn('psql', ['$DATABASE_URL']);",
    "const m = /token/.exec(line);",
    "const hit = TOKEN_RE.exec(token);",
    "const args = ['-c', 'select 1'];\nspawn('psql', args);\nconst d = dsn;",
    // a call's RESULT is not tainted by the env it was given
    "const r = spawnSync('a', [], { env: { ...process.env, DATABASE_URL: dsn } });\nspawnSync('b', [r.stdout]);",
    // a secret-named KEY with a harmless value does not taint the object
    "const cfg = { apiKey: 'public-client-id' };\nspawn('x', [cfg.id]);",
    // a member that shares a tainted global's name is not that global
    "url = dsn;\nspawn('x', [req.url]);",
    // taint follows the symbol, not the name
    "function f() { const out = dsn; return out; }\nfunction g() { const out = 'x'; spawn('ls', [out]); }",
    // an options bag held in a variable is still options
    "const o = { cwd: '/' };\nexecFile('ls', o);",
    "const opts = { env: { ...process.env, DATABASE_URL: dsn } };\nspawn('x', opts);",
    // no shell, no expansion
    "spawn('psql', ['$DATABASE_URL'], { shell: false });",
    "spawn('bash', ['script.sh', '$DATABASE_URL']);",
    // -c belongs to grep here; the shell word after it is just a pattern
    "spawn('grep', ['-c', 'bash', '$DATABASE_URL']);",
    // a function that USES a secret but returns something else
    "function main() { const d = dsn; use(d); return 0; }\nspawn('x', [String(main())]);",
    // a command from a function this file defines is classified, not denied
    "function cmd() { return 'ls'; }\nspawn(cmd(), []);\nconst d = dsn;",
    // concatenation can single-quote a $NAME that looks bare in one piece
    "execSync(\"echo '\" + '$DATABASE_URL' + \"'\", { env });",
    // a NUL stands in for a non-literal piece, so pieces never fuse into a name
    "execSync('echo $' + v + 'DATABASE_URL', { env });",
    // writing the secret INTO the environment is the fix; it must not taint `process`
    "process.env.DATABASE_URL = databaseUrl;\nspawnSync(process.execPath, ['x.ts']);",
    "Object.assign(process.env, { DATABASE_URL: dsn });\nspawnSync(process.execPath, ['x.ts']);",
    "const main = () => { const d = dsn; use(d); return 0; };\nspawn('x', [String(main())]);",
    // feature-testing the import is not a use
    "if (typeof spawn === 'function') spawn('ls', []);\nconst d = dsn;",
    // names that describe a secret without holding one
    "spawn('psql', ['--password-file', passwordFile]);",
    "spawn('curl', ['-b', cookieJarPath, secretName, credentialsPath]);",
  ])('%s', (body) => {
    expect(scan(body)).toEqual([]);
  });

  it.each([
    // generic nouns that are not credentials; any one would also arm deny-by-default
    "spawn('git', ['log', cacheKey]);",
    "spawn('x', [firstPass]);",
    "execSync(`git show ${commitKey}`);",
    "const sortKey = 1;\nconst nextToken = 'n';\nspawn(cmd, buildArgs());",
    "const pwd = process.cwd();\nspawn('ls', [pwd]);",
  ])('a non-credential name: %s', (body) => {
    expect(scan(body)).toEqual([]);
  });

  it.each([
    // mentioning the import in a type, or a key that shares its name, is not a use
    "type R = ReturnType<typeof execFileSync>;\nconst d = dsn;",
    "const table = { exec: 1, spawn: 2 };\nconst d = dsn;",
    "import type { SpawnOptions } from 'node:child_process';\nconst o: SpawnOptions = {};\nconst d = dsn;",
  ])('a non-call mention: %s', (body) => {
    expect(scan(body)).toEqual([]);
  });

  it('ignores a file that never loads child_process', () => {
    expect(scanSource('function spawn(x: string) {}\nspawn(dsn);')).toEqual([]);
  });
});

describe('deny by default', () => {
  it.each([
    "const run = promisify(execFile);\nconst u = process.env.DATABASE_URL;",
    "const run = promisify(exec);\nrun('psql \"$DATABASE_URL\"');",
    "spawn('psql', buildArgs(), {});\nconst d = dsn;",
    "spawn('psql', ['-d', x;\nconst d = dsn;",
    "const s = execSync;\nconst d = dsn;",
    "spawn(getCmd(), ['x']);\nconst d = dsn;",
    "function f(a: string[]) { spawn('x', a); }\nconst d = dsn;",
    "function build() { return ['-d', dsn]; }\nconst args = build();\nspawn('psql', args);",
    "spawn('psql', ['x', ...build()]);\nconst d = dsn;",
    "spawn(...build());\nconst d = dsn;",
    // a literal argv reassigned later is no longer known
    "let a = ['x'];\na = getArgs();\nspawn('psql', a);\nconst d = dsn;",
    // a namespace used other than to call a spawn function
    "import * as cp from 'child_process';\nconst c = cp;\nconst d = dsn;",
    "import * as cp from 'child_process';\nconst f = cp.spawn;\nconst d = dsn;",
    "import * as cp from 'child_process';\ncp[k]('psql', []);\nconst d = dsn;",
    // a parameter default is not a variable initialised with a literal
    "function f(a = ['-c']) { spawn('psql', a); }\nconst d = dsn;",
    // options it cannot see might set shell: true
    "spawn('psql', ['\"$DATABASE_URL\"'], getOpts());",
    // a command or argv it cannot read may be a shell
    "const sh = process.env.SHELL ?? 'sh';\nspawn(sh, ['-c', 'psql \"$DATABASE_URL\"'], { env });",
    "const a = ['-c'];\nspawn('sh', [...a, 'psql \"$DATABASE_URL\"'], { env });",
    // an options bag reassigned by a declaration-less for…of is not the literal
    "let o = {};\nfor (o of [{ shell: true }]) use(o);\nspawn('echo', ['$DATABASE_URL'], o);",
  ])('fails what it cannot classify, in a file that mentions a secret: %s', (body) => {
    expect(scan(body).some((r) => r.startsWith('unclassifiable'))).toBe(true);
  });

  it.each([
    "await import('node:child_process')",
    "require('child_process')",
    "module.require('child_process')",
    "process.getBuiltinModule('node:child_process')",
    "createRequire(import.meta.url)('child_process')",
  ])(
    'fails a dynamic load: %s',
    (load) => {
      // No static import here: the dynamic load has to be caught on its own.
      const reasons = scanSource(`const cp = ${load};\ncp.spawn('psql', [x]);\nconst d = dsn;`).map((f) => f.reason);
      expect(reasons.join('\n')).toContain('loaded other than by a static import');
    },
  );

  it('fails a loader built with createRequire, a re-export, or the name parked for later', () => {
    const viaVar = "const req = createRequire(import.meta.url);\nconst cp = req('child_process');\nconst d = dsn;";
    const reexport = "export { spawn as run } from 'child_process';\nconst d = dsn;";
    const inObject = "const mods = { cp: 'child_process' };\nconst d = dsn;";
    const assigned = "let m;\nm = 'child_process';\nconst d = dsn;";
    const internal = "Module._load('child_process');\nconst d = dsn;";
    const parked = "const name = 'child_process';\nconst d = dsn;";
    for (const src of [viaVar, reexport, inObject, assigned, internal, parked]) {
      expect(scanSource(src).map((f) => f.reason).join('\n')).toContain('loaded other than by a static import');
    }
  });

  it('a type-only import of a spawn function is never a value use', () => {
    for (const imp of ["import { type spawn } from 'child_process';", "import type { spawn } from 'child_process';"]) {
      // A value use of a type-only import is a compile error, not a spawn: never 'used as a value'.
      expect(scanSource(`${imp}\ntype S = typeof spawn;\nconst f = spawn;\nconst d = dsn;`)).toEqual([]);
    }
  });

  it('recognises an element-access namespace call as a call, not a bare namespace', () => {
    expect(spawnCalls("import * as cp from 'child_process';\ncp['spawn']('ls', []);")).toEqual(['spawn@2']);
  });

  it('a child_process string used as data is not a load', () => {
    const src = "const mods = new Set(['child_process']);\nif (text.includes('child_process')) use(mods);\nconst d = dsn;";
    expect(scanSource(`${IMPORT}${src}`)).toEqual([]);
  });

  it('does not crash on Object.prototype member names', () => {
    const src = "import * as cp from 'child_process';\ncp.hasOwnProperty('spawn');\ncp.toString();\nconst d = dsn;";
    expect(() => scanSource(src)).not.toThrow();
    expect(scanSource(src)).toEqual([]);
  });

  it('says nothing when the file mentions no secret', () => {
    expect(scan('const run = promisify(execFile);')).toEqual([]);
  });

  it('an allowed site suppresses a real violation, and only there', () => {
    const src = `${IMPORT}spawn('psql', [dsn]);`;
    expect(scanSource(src, 'scripts/x.ts')).not.toEqual([]);
    expect(scanSource(src, 'scripts/x.ts', new Set(['scripts/x.ts:dsn']))).toEqual([]);
    expect(scanSource(src, 'scripts/y.ts', new Set(['scripts/x.ts:dsn']))).not.toEqual([]);
  });
});

describe('known limits — these leak and pass; pinned so a widening sees the edge', () => {
  it.each([
    // a secret passed in as an innocently named parameter
    "export function run(url: string) { spawn('psql', [url]); }",
    // a secret imported from another module under an innocent name
    "import { url } from './config.js';\nspawn('psql', [url]);",
    // a value rethrown into a catch binding
    "try { throw dsn; } catch (u) { spawn('psql', [String(u)]); }",
    // a value served by an Object.defineProperty getter
    "const o: { u?: string } = {};\nObject.defineProperty(o, 'u', { get: () => dsn });\nspawn('psql', [o.u!]);",
  ])('%s', (body) => {
    expect(scan(body)).toEqual([]);
  });

  it('a third-party spawner is not recognised', () => {
    expect(scanSource("import { execa } from 'execa';\nexeca('psql', [dsn]);")).toEqual([]);
  });

  it('a module name built at runtime never mentions child_process, so the file is skipped', () => {
    expect(scanSource("const m = 'child_' + 'process';\nconst cp = require(m);\ncp.spawn('psql', [dsn]);")).toEqual([]);
  });

  it('a wrapper in another file hides the secret from both halves', () => {
    const wrapper = "import { execFileSync } from 'child_process';\nexport const run = (a: string[]) => execFileSync('x', a);";
    const caller = "import { run } from './wrapper.js';\nrun(['-d', process.env.DATABASE_URL!]);";
    expect(scanSource(wrapper)).toEqual([]);
    expect(scanSource(caller)).toEqual([]);
  });
});

describe('shellExpansions', () => {
  it.each([
    ['"$X"', ['X']],
    ['${X}', ['X']],
    ["'$X'", []],
    ["\"it's $X\"", ['X']],
    ["'a\\' $X", ['X']],
    ['\\$X', []],
    ["echo \"don't\" \"$X\" 'y'", ['X']],
  ] as const)('%s', (text, expected) => {
    expect(shellExpansions(text)).toEqual(expected);
  });
});

describe('isSecretName', () => {
  it.each([
    'DATABASE_URL', 'databaseUrl', 'dbUrl', 'pgUrl', 'PGPASSWORD', 'pgPass', 'dbPassword', 'pw',
    'dsn', 'dsnArgs', 'apiKey', 'API_KEY', 'serviceRoleKey', 'SUPABASE_SERVICE_ROLE_KEY', 'supabaseKey',
    'authToken', 'accessToken', 'CODEBERG_TOKEN', 'TELEGRAM_TOKEN', 'token', 'jwt', 'bearer', 'creds',
    'connStr', 'connectionString', 'authHeader', 'authorization', 'BREVO_SMTP_PASS', 'CODEBERG_ACCOUNTS',
    'secretKey', 'cookie', 'DEPLOY_KEY', 'VERCEL_TOKEN', 'GITLAB_PAT', 'DATABASE_URI', 'MONGO_URI',
    'dbUri', 'REDIS_URL', 'pgConn', 'PGPASS', 'PASSPHRASE', 'passphrase', 'sshKey', 'deployKey', 'privKey',
    'hfToken', 'NPM_AUTH',
  ])('%s is a secret', (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each([
    'cacheKey', 'sortKey', 'commitKey', 'primaryKey', 'nextToken', 'pageToken', 'firstPass', 'secondPass',
    'pwd', 'url', 'supabaseUrl', 'key', 'keys', 'tokenCount', 'script', 'env', 'repoRoot', 'execPath',
    'passwordFile', 'cookieJar', 'secretName', 'jwtExpiry', 'credentialsPath', 'secretsDir', 'NEXT_PAGE_TOKEN',
    'PRIMARY_KEY', 'SORT_KEY', 'secretId', 'keyId',
  ])('%s is not', (name) => {
    expect(isSecretName(name)).toBe(false);
  });
});
