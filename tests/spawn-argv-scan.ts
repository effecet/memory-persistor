/**
 * Scanner behind tests/spawn-argv-guard.test.ts: no secret may reach the argv
 * of a process spawned through Node's `child_process`.
 *
 * Process argv is world-readable (`/proc/<pid>/cmdline`, `ps` on macOS); the
 * environment block is not. The sibling guards cover Python
 * (tests/test_psql_call_sites.py) and Makefile/shell/workflows
 * (tests/test_dsn_argv_interpolation.py). This one covers every tracked
 * TypeScript and JavaScript file.
 *
 * WHY AN AST, NOT A LEXER. A first cut hand-lexed TypeScript in pytest. Its
 * review found five silent misses and three push-blocking false positives,
 * every one a parsing gap: an import list with a comment in it, a default
 * plus named import, `typeof execFileSync` in a type, an object key named
 * `exec`, nested generics, regex literals. The compiler's own parser has none
 * of those gaps, `typescript` is already a devDependency, and CI runs `npm ci`
 * and vitest in the same job as pytest. The type checker resolves every name
 * to a symbol, so taint follows scope rather than spelling.
 *
 * THE PROPERTY. A secret-shaped identifier (see `isSecretName`), or anything
 * tainted by one, never appears in the COMMAND or ARGV of spawn / spawnSync /
 * execFile / execFileSync / fork, nor in the command of exec / execSync. The
 * OPTIONS argument is exempt — `{ env: { ...process.env, DSN } }` is the shape
 * every fix in this class steers toward — except `argv0` and `execArgv`, which
 * ARE argv.
 *
 * TAINT, within one file. It flows through declarations, destructuring (keys
 * included), assignments (`=`, `+=`, `??=`…), mutation (`push`, `unshift`,
 * `splice`, `fill`, `Map/Set` `set`/`add`, `Object.assign`, `a[i] =`, including
 * through an alias), `for…of` (with or without a declaration), array-callback
 * and `reduce` parameters, parameter defaults, `this.x` / class fields, and the
 * RETURN values of same-file functions, methods and getters. A variable is
 * trusted as an argv or options LITERAL only if nothing reassigns it.
 *
 * SHELL TEXT. When a shell runs the command — exec/execSync, `shell: true`, or
 * `sh`/`bash`/… with a `-c`-style flag (also via `env`) — a `$NAME` in the
 * string is expanded by the shell into the child's argv, even though the value
 * itself travelled in env: `execSync('psql "$DATABASE_URL"', { env })` leaks.
 * Quoting is tracked the way sh does (single quotes suppress, double quotes do
 * not), across `+` concatenation and template substitutions.
 *
 * DENY BY DEFAULT. In a file that mentions a secret, anything this scanner
 * cannot classify fails:
 *   - a child_process function used as a value (`promisify(execFile)`);
 *   - any `child_process` load that is not a static import (`require`,
 *     `import()`, `createRequire`, `getBuiltinModule`, `Module._load`, a
 *     re-export, or the name parked in a variable, object or assignment);
 *   - a namespace passed around bare;
 *   - an argv that is neither an array literal nor a variable initialised with
 *     one, or a spread of anything but such a variable;
 *   - spread call arguments (`spawn(...build())`);
 *   - a command computed by a function this file does not define;
 *   - a command, argv or options it cannot resolve, when the argv carries
 *     `$NAME` text a shell would expand (the command might be `$SHELL`);
 *   - a syntax error.
 *
 * KNOWN LIMITS (pinned in the guard's tests). Taint is per file: a secret
 * passed in as an innocently named parameter, imported from another module,
 * handed to a wrapper defined in another file, or rethrown into a `catch`
 * binding, or returned by an `Object.defineProperty` getter, is not followed.
 * A file whose text never contains `child_process`
 * (the name built at runtime) is skipped. Third-party spawners (execa, zx,
 * Bun.spawn) are not recognised.
 */
// The compiler API (SyntaxKind, createSourceFile) left the `typescript` package in
// TS 7; this scanner uses TS 5's parser through a dev-only alias. The build is TS 7.
import ts from 'typescript-api';

export type Finding = { line: number; reason: string };

const CP_MODULES = new Set(['child_process', 'node:child_process']);

/** child_process function → the argument positions that reach argv. */
export const SPAWN_ARGV_POSITIONS: Readonly<Record<string, readonly number[]>> = {
  spawn: [0, 1],
  spawnSync: [0, 1],
  execFile: [0, 1],
  execFileSync: [0, 1],
  fork: [0, 1],
  exec: [0],
  execSync: [0],
};
const isSpawnFn = (name: string): boolean => Object.hasOwn(SPAWN_ARGV_POSITIONS, name);
const SHELL_STRING_FNS = new Set(['exec', 'execSync']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;
/** Options fields that end up in the child's argv despite living in options. */
const ARGV_OPTIONS = new Set(['argv0', 'execArgv']);
const MUTATORS = new Set(['push', 'unshift', 'splice', 'fill', 'set', 'add']);
const ARRAY_CALLBACKS = new Set(['forEach', 'map', 'flatMap', 'filter', 'find', 'some', 'every']);
const REDUCERS = new Set(['reduce', 'reduceRight']);
/** Methods that take a string as DATA — a `'child_process'` argument to these is not a load. */
const DATA_METHODS = new Set([
  'includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'has', 'add', 'delete', 'test', 'match',
  'matchAll', 'replace', 'replaceAll', 'split', 'localeCompare', 'push', 'concat',
]);
const ASSIGNMENT_OPS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/**
 * Site-scoped exemptions, `${repo-relative path}:${identifier}`. Empty by
 * design — an entry is a decision someone must justify.
 */
export const ALLOWED_ARGV_SITES: ReadonlySet<string> = new Set();

// ───────────────────────────── secret names ─────────────────────────────
//
// Word-based, not the shell guard's suffix regex. TypeScript writes `cacheKey`,
// `sortKey`, `nextToken`, `firstPass`; a `.*_KEY` rule applied to camelCase
// flags all of them, and one such name anywhere in a file would also arm
// deny-by-default for every call in it. So a generic noun (key, token, pass,
// url) counts only after a head word that makes it a credential, and a name
// ending in a metadata noun (`passwordFile`, `secretName`) describes a secret
// without holding one.

const STRONG_WORDS = new Set([
  'password', 'passwd', 'passphrase', 'pw', 'pgpassword', 'pgpass', 'secret', 'secrets', 'credential',
  'credentials', 'creds', 'dsn', 'jwt', 'bearer', 'cookie', 'cookies', 'apikey', 'authorization',
  'privatekey',
]);
const URL_HEADS = new Set([
  'database', 'db', 'pg', 'postgres', 'postgresql', 'conn', 'connection', 'redis', 'mongo', 'mongodb',
  'mysql', 'amqp', 'rabbitmq',
]);
const HEADS: Readonly<Record<string, ReadonlySet<string>>> = {
  key: new Set([
    'api', 'secret', 'private', 'priv', 'access', 'signing', 'encryption', 'anon', 'role', 'service',
    'supabase', 'stripe', 'openai', 'anthropic', 'hf', 'huggingface', 'master', 'client', 'brevo', 'smtp',
    'ssh', 'deploy', 'gpg', 'pgp',
  ]),
  token: new Set([
    'auth', 'access', 'bearer', 'refresh', 'api', 'id', 'bot', 'github', 'gh', 'codeberg', 'forgejo',
    'gitea', 'telegram', 'session', 'personal', 'csrf', 'oauth', 'npm', 'hf', 'huggingface', 'slack',
    'discord',
  ]),
  pass: new Set(['db', 'pg', 'smtp', 'postgres', 'mysql', 'redis', 'admin', 'root', 'user', 'brevo']),
  url: URL_HEADS,
  uri: URL_HEADS,
  conn: new Set(['pg', 'db', 'database', 'postgres', 'redis', 'mongo']),
  str: new Set(['conn', 'connection']),
  string: new Set(['conn', 'connection']),
  header: new Set(['auth']),
  accounts: new Set(['gitea']),
};
/** A trailing noun that names a secret's metadata rather than its value. */
const METADATA_TAILS = new Set([
  'file', 'files', 'path', 'paths', 'dir', 'name', 'names', 'expiry', 'expires', 'ttl', 'jar', 'length',
  'len', 'count', 'size', 'prompt', 'field', 'label', 'regex', 're', 'pattern', 'type', 'env', 'var', 'id',
]);
/** SCREAMING_SNAKE env-var names follow the shell convention: `*_TOKEN` is a secret… */
const SCREAMING_TAILS = new Set(['token', 'key', 'pass', 'pat', 'secret', 'password', 'auth']);
/** …unless the head makes it a database or pagination key. */
const SCREAMING_NOT_SECRET_HEADS = new Set([
  'primary', 'sort', 'foreign', 'partition', 'cache', 'page', 'next', 'prev', 'continuation', 'cursor',
  'idempotency', 'lock', 'map', 'group', 'unique', 'composite',
]);

export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function isSecretName(name: string): boolean {
  const ws = words(name);
  if (ws.length === 0) return false;
  if (METADATA_TAILS.has(ws[ws.length - 1])) return false;
  if (ws.some((w) => STRONG_WORDS.has(w))) return true;
  if (ws.length === 1 && ws[0] === 'token') return true;
  for (let i = 0; i + 1 < ws.length; i++) {
    if (HEADS[ws[i + 1]]?.has(ws[i])) return true;
  }
  return (
    /^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(name) &&
    SCREAMING_TAILS.has(ws[ws.length - 1]) &&
    !SCREAMING_NOT_SECRET_HEADS.has(ws[ws.length - 2])
  );
}

/**
 * `$NAME` / `${NAME}` a POSIX shell would expand. Tracks quote state as sh
 * does: single quotes suppress expansion (unless inside double quotes, where
 * `'` is literal), backslash escapes outside single quotes.
 */
export function shellExpansions(text: string): string[] {
  const out: string[] = [];
  let quote: '' | "'" | '"' = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== "'" && c === '\\') {
      i++;
    } else if (quote === '' && (c === "'" || c === '"')) {
      quote = c;
    } else if (quote !== '' && c === quote) {
      quote = '';
    } else if (quote !== "'" && c === '$') {
      const m = /^\{?([A-Za-z_]\w*)/.exec(text.slice(i + 1));
      if (m) out.push(m[1]);
    }
  }
  return out;
}

// ───────────────────────────── parsing ─────────────────────────────

type Key = ts.Symbol | string;
type Call = { fn: string; node: ts.CallExpression; opts: ts.Expression | undefined };
type Edge = { target: Key; sources: ts.Node[]; direct: boolean };

function scriptKind(fileName: string): ts.ScriptKind {
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function parse(fileName: string, text: string): { sf: ts.SourceFile; checker: ts.TypeChecker; syntaxErrors: number } {
  const path = `/virtual/${fileName}`;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const host: ts.CompilerHost = {
    getSourceFile: (f) => (f === path ? sf : undefined),
    getDefaultLibFileName: () => '/virtual/lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/virtual',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => f === path,
    readFile: () => undefined,
  };
  const program = ts.createProgram([path], { noLib: true, noResolve: true, allowJs: true, types: [] }, host);
  return { sf, checker: program.getTypeChecker(), syntaxErrors: program.getSyntacticDiagnostics(sf).length };
}

function isCpSpecifier(node: ts.Node | undefined): boolean {
  return node !== undefined && ts.isStringLiteralLike(node) && CP_MODULES.has(node.text);
}

function inTypePosition(node: ts.Node): boolean {
  return ts.findAncestor(node.parent, (p) => (ts.isStatement(p) ? 'quit' : ts.isTypeNode(p))) !== undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (ts.isNonNullExpression(n) || ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) {
    n = n.expression;
  }
  return n;
}

/** `a` in `a.b[c]` — the binding a write through this expression lands on. */
function rootIdentifier(node: ts.Expression): ts.Identifier | undefined {
  let n = unwrap(node);
  while (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) n = unwrap(n.expression);
  return ts.isIdentifier(n) ? n : undefined;
}

/** A property name as text, for identifiers and string-literal keys. */
function propertyNameText(name: ts.Node | undefined): string | undefined {
  if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isPrivateIdentifier(name))) return name.text;
  return undefined;
}

/** The literal member name of `x.name` / `x['name']`, if any. */
function memberName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

/** The options argument: exempt from argv (bar ARGV_OPTIONS), and where `env` belongs. */
function optionsArg(fn: string, node: ts.CallExpression, isObjectish: (e: ts.Expression) => boolean): ts.Expression | undefined {
  const args = node.arguments;
  if (SHELL_STRING_FNS.has(fn)) return args[1];
  return args[1] && isObjectish(args[1]) ? args[1] : args[2];
}

/**
 * String text as a shell would see it, with every non-literal piece replaced
 * by a NUL. Joins template pieces and `+` chains so quotes pair across them.
 */
function shellText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => `\0${s.literal.text}`).join('');
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = shellText(node.left);
    const r = shellText(node.right);
    if (l === undefined && r === undefined) return undefined;
    return (l ?? '\0') + (r ?? '\0');
  }
  if (ts.isParenthesizedExpression(node)) return shellText(node.expression);
  return undefined;
}

class FileScan {
  readonly named = new Map<ts.Symbol, string>();
  readonly namespaces = new Set<ts.Symbol>();
  readonly calls: Call[] = [];
  readonly unclassified: Finding[] = [];
  readonly edges: Edge[] = [];
  readonly options = new Set<ts.Node>();
  readonly tainted = new Set<Key>();
  readonly shellTainted = new Set<Key>();
  readonly recognisedSpecifiers = new Set<ts.Node>();
  readonly reassigned = new Set<ts.Symbol>();
  usesChildProcess = false;

  constructor(
    readonly sf: ts.SourceFile,
    readonly checker: ts.TypeChecker,
    readonly syntaxErrors: number,
  ) {}

  line(node: ts.Node): number {
    return this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf)).line + 1;
  }

  symbolOf(node: ts.Node): ts.Symbol | undefined {
    if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
      return this.checker.getShorthandAssignmentValueSymbol(node.parent);
    }
    return this.checker.getSymbolAtLocation(node);
  }

  keyOf(id: ts.Identifier): Key {
    return this.symbolOf(id) ?? `name:${id.text}`;
  }

  /** `this.u` / `obj.u`: the property's symbol, else its spelled path. */
  memberKey(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): Key {
    const name = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
    return this.symbolOf(name) ?? `member:${unwrap(node.expression).getText(this.sf)}.${memberName(node) ?? '?'}`;
  }

  /**
   * Every binding a write to `target` taints: the member written, and its root
   * when the root is a variable this file declares — `o.url = dsn` taints a
   * local `o`, but `process.env.X = dsn` must not taint `process`, or
   * `spawn(process.execPath, …)` fails on the very fix this guard steers to.
   */
  writeKeys(target: ts.Expression): Key[] {
    const t = unwrap(target);
    const keys: Key[] = [];
    if (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) keys.push(this.memberKey(t));
    const root = rootIdentifier(t);
    const rootDecl = root && this.symbolOf(root)?.valueDeclaration;
    if (root && (t === root || (rootDecl !== undefined && rootDecl.getSourceFile() === this.sf))) keys.push(this.keyOf(root));
    return keys;
  }

  edge(targets: Key[], sources: ts.Node[], direct = false): void {
    for (const target of targets) this.edges.push({ target, sources, direct });
  }

  /**
   * What a variable holds, from its initializer — only when nothing ever
   * reassigns it. `let a = ['x']; a = getArgs();` must not pass as a literal.
   */
  initializerOf(e: ts.Expression): ts.Expression | undefined {
    const n = unwrap(e);
    if (!ts.isIdentifier(n)) return n;
    const sym = this.symbolOf(n);
    const decl = sym?.valueDeclaration;
    if (!sym || this.reassigned.has(sym) || !decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
    return unwrap(decl.initializer);
  }

  /** An object literal, or a never-reassigned variable initialised with one: a named options bag. */
  objectInitializer(e: ts.Expression): ts.ObjectLiteralExpression | undefined {
    const init = this.initializerOf(e);
    return init && ts.isObjectLiteralExpression(init) ? init : undefined;
  }

  /** An array literal, or a never-reassigned variable initialised with one. */
  arrayInitializer(e: ts.Expression): ts.ArrayLiteralExpression | undefined {
    const init = this.initializerOf(e);
    return init && ts.isArrayLiteralExpression(init) ? init : undefined;
  }

  /** A string literal, or a never-reassigned variable initialised with one. */
  stringValue(e: ts.Expression): string | undefined {
    const init = this.initializerOf(e);
    return init && ts.isStringLiteralLike(init) ? init.text : undefined;
  }

  /**
   * Properties named `name` in an options bag, through `...spread` bags.
   * `opaque` is set when some part of the bag cannot be resolved.
   */
  bagProps(bag: ts.Expression, name: string, seen = new Set<ts.Node>()): { props: ts.ObjectLiteralElementLike[]; opaque: boolean } {
    const obj = this.objectInitializer(bag);
    if (!obj || seen.has(obj)) return { props: [], opaque: !obj };
    seen.add(obj);
    const props: ts.ObjectLiteralElementLike[] = [];
    let opaque = false;
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) {
        const inner = this.bagProps(p.expression, name, seen);
        props.push(...inner.props);
        opaque ||= inner.opaque;
      } else if (propertyNameText(p.name) === name) {
        props.push(p);
      }
    }
    return { props, opaque };
  }

  /** Does this file define the function a call invokes? */
  definesCallee(call: ts.CallExpression): boolean {
    const callee = unwrap(call.expression);
    const sym = ts.isIdentifier(callee) ? this.symbolOf(callee)
      : ts.isPropertyAccessExpression(callee) ? this.symbolOf(callee.name) : undefined;
    const decl = sym?.valueDeclaration;
    return decl !== undefined && decl.getSourceFile() === this.sf;
  }

  // ───────────── collection ─────────────

  collectImports(): void {
    for (const stmt of this.sf.statements) {
      if (ts.isImportDeclaration(stmt) && isCpSpecifier(stmt.moduleSpecifier)) {
        this.usesChildProcess = true;
        this.recognisedSpecifiers.add(stmt.moduleSpecifier);
        const clause = stmt.importClause;
        if (!clause || clause.isTypeOnly) continue;
        const add = (id: ts.Identifier, into: 'ns' | string): void => {
          const sym = this.symbolOf(id);
          if (!sym) return;
          if (into === 'ns') this.namespaces.add(sym);
          else this.named.set(sym, into);
        };
        if (clause.name) add(clause.name, 'ns');
        const b = clause.namedBindings;
        if (b && ts.isNamespaceImport(b)) add(b.name, 'ns');
        if (b && ts.isNamedImports(b)) {
          for (const el of b.elements) {
            const fn = (el.propertyName ?? el.name).text;
            if (!el.isTypeOnly && isSpawnFn(fn)) add(el.name, fn);
          }
        }
      } else if (
        ts.isImportEqualsDeclaration(stmt) &&
        ts.isExternalModuleReference(stmt.moduleReference) &&
        isCpSpecifier(stmt.moduleReference.expression)
      ) {
        this.usesChildProcess = true;
        this.recognisedSpecifiers.add(stmt.moduleReference.expression);
        const sym = this.symbolOf(stmt.name);
        if (sym) this.namespaces.add(sym);
      }
    }
  }

  walk(): void {
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && isCpSpecifier(node) && !this.recognisedSpecifiers.has(node) && this.isLoad(node)) {
        // require, import(), createRequire(...)(), getBuiltinModule, export … from:
        // any load but a static import is one this scanner cannot follow.
        this.usesChildProcess = true;
        this.unclassified.push({ line: this.line(node), reason: 'child_process loaded other than by a static import' });
      }
      if (ts.isCallExpression(node)) this.onCall(node);
      if (ts.isIdentifier(node)) this.onIdentifier(node);
      if (ts.isVariableDeclaration(node) && node.initializer) this.bindVariable(node.name, node.initializer);
      if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
        if (ts.isVariableDeclarationList(node.initializer)) {
          for (const d of node.initializer.declarations) this.bind(d.name, node.expression);
        } else {
          this.noteReassigned(node.initializer);
          this.edge(this.writeKeys(node.initializer), [node.expression]);
        }
      }
      if (ts.isParameter(node) && node.initializer) this.bind(node.name, node.initializer);
      if (ts.isPropertyDeclaration(node) && node.initializer) {
        const sym = this.symbolOf(node.name);
        if (sym) this.edge([sym], [node.initializer]);
      }
      if (ts.isFunctionLike(node)) this.onFunction(node);
      if (ts.isBinaryExpression(node) && ASSIGNMENT_OPS.has(node.operatorToken.kind)) {
        const left = unwrap(node.left);
        this.noteReassigned(left);
        if (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left)) {
          this.bindAssignmentPattern(left, node.right);
        } else {
          this.edge(this.writeKeys(left), [node.right]);
          // `a = b` aliases: a later write through `a` lands on `b` too.
          const right = unwrap(node.right);
          if (ts.isIdentifier(right) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            this.edge([this.keyOf(right)], [node.left]);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sf);
  }

  /**
   * Is this `'child_process'` literal a module load rather than data (a Set
   * member, a comparison)? Loads: require / module.require / import() /
   * getBuiltinModule / createRequire(…)(…) arguments, `export … from`, or a
   * variable holding the name, which is how it would be fed to a loader.
   */
  isLoad(lit: ts.StringLiteralLike): boolean {
    const p = lit.parent;
    // Held for later: a variable, an object value, an assignment, a re-export.
    if (ts.isExportDeclaration(p) || ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) return true;
    if (ts.isBinaryExpression(p) && p.right === lit && ASSIGNMENT_OPS.has(p.operatorToken.kind)) return true;
    // Passed to anything that is not a string/collection data method: require,
    // import(), getBuiltinModule, createRequire(…)(…), Module._load, a wrapper…
    if (!ts.isCallExpression(p)) return false;
    const callee = unwrap(p.expression);
    return !(ts.isPropertyAccessExpression(callee) && DATA_METHODS.has(callee.name.text));
  }

  noteReassigned(target: ts.Expression): void {
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const sym = this.symbolOf(n);
        if (sym) this.reassigned.add(sym);
      } else if (ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n) || ts.isPropertyAssignment(n) ||
        ts.isShorthandPropertyAssignment(n) || ts.isSpreadElement(n) || ts.isSpreadAssignment(n)) {
        ts.forEachChild(n, visit);
      } else if (ts.isPropertyAssignment(n.parent) && n.parent.initializer === n) {
        visit(n);
      }
    };
    visit(unwrap(target));
  }

  bindVariable(name: ts.BindingName, init: ts.Expression): void {
    // A function value is tainted by what it RETURNS (onFunction), not by every
    // name its body happens to read.
    if (ts.isArrowFunction(unwrap(init)) || ts.isFunctionExpression(unwrap(init))) return;
    this.bind(name, init);
    // `const b = a` aliases: `b.push(dsn)` writes into `a` as well.
    const right = unwrap(init);
    if (ts.isIdentifier(name) && ts.isIdentifier(right)) this.edge([this.keyOf(right)], [name]);
  }

  /** `const { DATABASE_URL: u = '' } = process.env`, nested patterns, computed keys. */
  bind(name: ts.BindingName, source: ts.Node): void {
    if (ts.isIdentifier(name)) {
      this.edge([this.keyOf(name)], [source]);
      return;
    }
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      const computedFromEnv = el.propertyName !== undefined && ts.isComputedPropertyName(el.propertyName) &&
        this.isProcessEnv(source);
      const key = propertyNameText(el.propertyName) ?? (ts.isIdentifier(el.name) ? el.name.text : '');
      const sources = el.initializer ? [source, el.initializer] : [source];
      if (ts.isIdentifier(el.name)) {
        this.edge([this.keyOf(el.name)], sources, isSecretName(key) || computedFromEnv);
      } else {
        this.bind(el.name, source);
      }
    }
  }

  /** `({ DATABASE_URL: u } = process.env)` — the KEY decides, as in `bind`. */
  bindAssignmentPattern(pattern: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, source: ts.Node): void {
    const elements = ts.isObjectLiteralExpression(pattern) ? pattern.properties : pattern.elements;
    for (const el of elements) {
      let target: ts.Expression | undefined;
      let key = '';
      if (ts.isPropertyAssignment(el)) {
        target = el.initializer;
        key = propertyNameText(el.name) ?? '';
      } else if (ts.isShorthandPropertyAssignment(el)) {
        target = el.name;
        key = el.name.text;
      } else if (ts.isSpreadAssignment(el) || ts.isSpreadElement(el)) {
        target = el.expression;
      } else if (ts.isExpression(el)) {
        target = el;
      }
      if (!target) continue;
      const t = unwrap(ts.isBinaryExpression(target) ? target.left : target);
      if (ts.isObjectLiteralExpression(t) || ts.isArrayLiteralExpression(t)) this.bindAssignmentPattern(t, source);
      else this.edge(this.writeKeys(t), [source], isSecretName(key));
    }
  }

  /** A function's symbol is tainted by what it returns. */
  onFunction(fn: ts.SignatureDeclaration): void {
    let key: Key | undefined;
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn)) && fn.name) {
      key = this.symbolOf(fn.name);
    } else if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
      key = this.keyOf(fn.parent.name);
    }
    if (!key || !('body' in fn) || !fn.body) return;
    const body = fn.body as ts.Node;
    if (!ts.isBlock(body)) {
      this.edge([key], [body]);
      return;
    }
    const returns: ts.Node[] = [];
    const visit = (n: ts.Node): void => {
      if (n !== fn && ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
      ts.forEachChild(n, visit);
    };
    visit(body);
    if (returns.length) this.edge([key], returns);
  }

  isProcessEnv(node: ts.Node): boolean {
    const n = ts.isExpression(node) ? unwrap(node) : node;
    if (n.getText(this.sf) === 'process.env') return true;
    if (!ts.isIdentifier(n)) return false;
    const decl = this.symbolOf(n)?.valueDeclaration;
    return decl !== undefined && ts.isVariableDeclaration(decl) && decl.initializer !== undefined &&
      unwrap(decl.initializer).getText(this.sf) === 'process.env';
  }

  onCall(node: ts.CallExpression): void {
    const callee = unwrap(node.expression);
    // args.push(dsn) / args['push'](dsn) taints args.
    if ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && MUTATORS.has(memberName(callee) ?? '')) {
      this.edge(this.writeKeys(callee.expression), [...node.arguments]);
    }
    // Object.assign(target, ...sources)
    if (callee.getText(this.sf) === 'Object.assign' && node.arguments[0]) {
      this.edge(this.writeKeys(node.arguments[0]), node.arguments.slice(1));
    }
    // [dsn].forEach(u => …): the callback's first parameter holds an element.
    if (ts.isPropertyAccessExpression(callee) && REDUCERS.has(callee.name.text)) {
      const cb = node.arguments[0];
      const ps = cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) ? cb.parameters : undefined;
      const initial = node.arguments[1];
      if (ps?.[0]) this.bind(ps[0].name, initial ?? callee.expression);
      if (ps?.[0] && initial) this.bind(ps[0].name, callee.expression);
      if (ps?.[1]) this.bind(ps[1].name, callee.expression);
    }
    if (ts.isPropertyAccessExpression(callee) && ARRAY_CALLBACKS.has(callee.name.text)) {
      const cb = node.arguments[0];
      const param = cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) ? cb.parameters[0] : undefined;
      if (param) this.bind(param.name, callee.expression);
    }
  }

  onIdentifier(id: ts.Identifier): void {
    const sym = this.symbolOf(id);
    if (!sym || !(this.named.has(sym) || this.namespaces.has(sym))) return;
    const parent = id.parent;
    if (
      ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent) || ts.isTypeOfExpression(parent) || inTypePosition(id)
    ) {
      return;
    }
    const fn = this.named.get(sym);
    if (fn !== undefined) {
      if (ts.isCallExpression(parent) && parent.expression === id) this.addCall(fn, parent);
      else this.unclassified.push({ line: this.line(id), reason: `\`${id.text}\` used as a value, not called` });
      return;
    }
    const member = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === id
      ? memberName(parent)
      : undefined;
    if (member === undefined) {
      this.unclassified.push({ line: this.line(id), reason: `namespace \`${id.text}\` used bare` });
      return;
    }
    if (!isSpawnFn(member)) return;
    const call = parent.parent;
    if (ts.isCallExpression(call) && call.expression === parent) this.addCall(member, call);
    else this.unclassified.push({ line: this.line(id), reason: `\`${id.text}.${member}\` used as a value, not called` });
  }

  addCall(fn: string, node: ts.CallExpression): void {
    this.calls.push({ fn, node, opts: undefined });
  }

  /** After the walk, when every reassignment is known: which argument is options. */
  resolveOptions(): void {
    for (const call of this.calls) {
      call.opts = optionsArg(call.fn, call.node, (e) => this.objectInitializer(e) !== undefined);
      if (call.opts) this.options.add(call.opts);
    }
  }

  // ───────────── references ─────────────

  /** Secret-shaped or tainted names read by `node`, skipping spawn options. */
  refs(node: ts.Node, skipOptions = true): string[] {
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
      if ((skipOptions && this.options.has(n)) || ts.isTypeNode(n)) return;
      if (ts.isIdentifier(n)) {
        const p = n.parent;
        const isKey =
          ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) ||
            ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === n) ||
          (ts.isBindingElement(p) && p.propertyName === n);
        if (isKey) return;
        if (ts.isPropertyAccessExpression(p) && p.name === n) {
          if (isSecretName(n.text) || this.tainted.has(this.memberKey(p))) out.push(n.text);
          return;
        }
        if (isSecretName(n.text) || this.tainted.has(this.keyOf(n))) out.push(n.text);
        return;
      }
      if (ts.isElementAccessExpression(n)) {
        const arg = n.argumentExpression;
        if (ts.isStringLiteralLike(arg)) {
          if (isSecretName(arg.text) || this.tainted.has(this.memberKey(n))) out.push(arg.text);
        } else if (this.isProcessEnv(n.expression)) {
          out.push('process.env[<computed key>]');
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  }

  /** `$SECRET` in text a shell would expand, plus shell-tainted names. */
  shellRefs(node: ts.Node): string[] {
    const out: string[] = [];
    const visit = (n: ts.Node, insideText: boolean): void => {
      if (this.options.has(n) || ts.isTypeNode(n)) return;
      const text = insideText ? undefined : shellText(n);
      if (text !== undefined) {
        out.push(...shellExpansions(text).filter(isSecretName).map((s) => `$${s}`));
      }
      if (ts.isIdentifier(n) && this.shellTainted.has(this.keyOf(n))) out.push(n.text);
      ts.forEachChild(n, (c) => visit(c, insideText || text !== undefined));
    };
    visit(node, false);
    return out;
  }

  propagate(): void {
    for (let changed = true; changed; ) {
      changed = false;
      for (const e of this.edges) {
        if (!this.tainted.has(e.target) && (e.direct || e.sources.some((s) => this.refs(s).length > 0))) {
          this.tainted.add(e.target);
          changed = true;
        }
        if (!this.shellTainted.has(e.target) && e.sources.some((s) => this.shellRefs(s).length > 0)) {
          this.shellTainted.add(e.target);
          changed = true;
        }
      }
    }
  }

  // ───────────── verdict ─────────────

  /**
   * The argv text a shell would run; undefined when no shell runs it; 'unknown'
   * when the options, command or argv cannot be resolved, so a shell cannot be
   * ruled out.
   */
  shellArgv({ fn, node, opts }: Call): ts.Node[] | 'unknown' | undefined {
    if (SHELL_STRING_FNS.has(fn)) return node.arguments[0] ? [node.arguments[0]] : [];
    const argvArgs = node.arguments.filter((a) => a !== opts);
    if (opts) {
      const { props, opaque } = this.bagProps(opts, 'shell');
      const on = props.some((p) => !(ts.isPropertyAssignment(p) && p.initializer.kind === ts.SyntaxKind.FalseKeyword));
      if (on) return argvArgs;
      if (opaque) return 'unknown';
    }
    // sh -c '…', bash -lc '…', and a shell behind any wrapper: env -i A=b sh -c,
    // sudo sh -c, timeout 5 bash -c. A shell word followed later by a -c-style
    // flag means the rest is shell text, whatever precedes it.
    const cmd = node.arguments[0] && this.stringValue(node.arguments[0]);
    const argv = node.arguments[1] && this.arrayInitializer(node.arguments[1]);
    // A command or argv it cannot read might be a shell (`process.env.SHELL`,
    // `[...flags, script]`): unknown, so shell text in it cannot be waved through.
    if (cmd === undefined || !argv || argv.elements.some((e) => ts.isSpreadElement(e))) return 'unknown';
    const words = [cmd, ...argv.elements.map((e) => this.stringValue(e))];
    const shellAt = words.findIndex((w) => w !== undefined && SHELLS.has(w.split('/').pop() ?? ''));
    if (shellAt < 0 || !words.slice(shellAt + 1).some((w) => w !== undefined && SHELL_COMMAND_FLAG.test(w))) return undefined;
    return [argv];
  }

  verdict(rel: string, allowed: ReadonlySet<string>): Finding[] {
    const findings: Finding[] = [];
    const report = (at: ts.Node, name: string, why: string): void => {
      if (!allowed.has(`${rel}:${name}`)) findings.push({ line: this.line(at), reason: `\`${name}\` ${why}` });
    };
    for (const call of this.calls) {
      const { fn, node, opts } = call;
      if (node.arguments.some((a, i) => i <= 1 && ts.isSpreadElement(a))) {
        this.unclassified.push({ line: this.line(node), reason: `\`${fn}\` arguments are spread` });
      }
      for (const pos of SPAWN_ARGV_POSITIONS[fn]) {
        const arg = node.arguments[pos];
        if (!arg || arg === opts) continue;
        if (pos === 0) {
          const cmd = unwrap(arg);
          if (ts.isCallExpression(cmd) && !this.definesCallee(cmd)) {
            this.unclassified.push({ line: this.line(arg), reason: `\`${fn}\` command comes from a function this file does not define` });
          }
        } else {
          const argv = this.arrayInitializer(arg);
          if (!argv) {
            this.unclassified.push({ line: this.line(arg), reason: `\`${fn}\` argv is not an array literal or a variable initialised with one` });
          } else {
            for (const el of argv.elements) {
              if (ts.isSpreadElement(el) && !this.arrayInitializer(el.expression)) {
                this.unclassified.push({ line: this.line(el), reason: `\`${fn}\` argv spreads something other than a local array` });
              }
            }
          }
        }
        for (const name of this.refs(arg)) report(arg, name, `reaches argv of \`${fn}\` — pass it via \`env\``);
      }
      // argv0 / execArgv live in options but land in argv.
      for (const field of ARGV_OPTIONS) {
        for (const p of opts ? this.bagProps(opts, field).props : []) {
          const value = ts.isPropertyAssignment(p) ? p.initializer : p;
          for (const name of this.refs(value, false)) report(p, name, `reaches argv of \`${fn}\` through \`${field}\``);
        }
      }
      const shellArgv = this.shellArgv(call);
      if (shellArgv === 'unknown') {
        const text = node.arguments.filter((a) => a !== opts).flatMap((a) => this.shellRefs(a));
        if (text.length) {
          this.unclassified.push({ line: this.line(node), reason: `\`${fn}\` may run a shell (unresolved command, argv or options) that would expand ${text.join(', ')}` });
        }
      }
      for (const a of shellArgv === 'unknown' ? [] : shellArgv ?? []) {
        for (const name of this.shellRefs(a)) report(a, name, `is expanded by the shell into argv of \`${fn}\``);
      }
    }
    const mentionsSecret = this.refs(this.sf, false).length > 0 || this.shellRefs(this.sf).length > 0;
    if (mentionsSecret) {
      if (this.syntaxErrors > 0) this.unclassified.push({ line: 1, reason: 'syntax error — cannot classify' });
      findings.push(...this.unclassified.map((u) => ({ line: u.line, reason: `unclassifiable: ${u.reason}` })));
    }
    const seen = new Set<string>();
    return findings
      .filter((f) => !seen.has(`${f.line}|${f.reason}`) && seen.add(`${f.line}|${f.reason}`))
      .sort((a, b) => a.line - b.line || a.reason.localeCompare(b.reason));
  }
}

function prepare(text: string, rel: string): FileScan {
  const { sf, checker, syntaxErrors } = parse(rel, text);
  const scan = new FileScan(sf, checker, syntaxErrors);
  scan.collectImports();
  scan.walk();
  scan.resolveOptions();
  return scan;
}

/** Every way to load the module names it literally, so no Program is needed otherwise. */
const mayUseChildProcess = (text: string): boolean => text.includes('child_process');

/** Every finding in one file. Empty when the file never touches child_process. */
export function scanSource(text: string, rel = 'snippet.ts', allowed: ReadonlySet<string> = ALLOWED_ARGV_SITES): Finding[] {
  if (!mayUseChildProcess(text)) return [];
  const scan = prepare(text, rel);
  if (!scan.usesChildProcess) return [];
  scan.propagate();
  return scan.verdict(rel, allowed);
}

/** The child_process calls the scanner recognises, as `fn@line` — for non-vacuity checks. */
export function spawnCalls(text: string, rel = 'snippet.ts'): string[] {
  if (!mayUseChildProcess(text)) return [];
  const scan = prepare(text, rel);
  return scan.calls.map(({ fn, node }) => `${fn}@${scan.line(node)}`);
}
