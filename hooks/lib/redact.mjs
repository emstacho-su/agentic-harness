/**
 * Secret redaction.
 *
 * The note carries user prompt text and tool *inputs*. Both can contain a key
 * somebody pasted. Every string that reaches the vault goes through `redact()`
 * first — there is no second path, and `tests/redaction.test.mjs` proves it over
 * a fixture transcript seeded with a JWT, an `sb_` key and a connection string.
 *
 * The rules are deliberately greedy. A false positive costs a `[REDACTED]` in a
 * note nobody was going to read closely; a false negative puts a live
 * credential in OneDrive and then in Postgres.
 */

const NAMED_ASSIGNMENT = 'named-secret-assignment';

export const SECRET_RULES = Object.freeze([
  // KEY=value / KEY: value / "key": "value" where the key name signals a secret.
  //
  // Three things this has to get right, each of which it previously did not:
  //
  //   - the closing backreference is `\1`, the *key's* quote. Version 1.0.0
  //     closed on the value group, so the rule only fired when the value
  //     happened to be the same string twice (`hunter2hunter2` matched; a real
  //     key did not);
  //   - the key may be quoted, so a JSON or YAML mapping is covered and not
  //     just a shell assignment;
  //   - a quoted value may contain spaces, because a passphrase usually does.
  //
  // `PAT` counts only as a word of the key (`GITHUB_PAT`, `githubPat`), not
  // as the letters inside `path`, `Pattern`, `dispatch` or `compat`: see
  // `namesASecret`. Such a key's value is left as it is, apart from any
  // assignment nested inside it (`path=PASSWORD=…`).
  {
    name: NAMED_ASSIGNMENT,
    re: /(["']?)\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|SERVICE[_-]?ROLE|ANON[_-]?KEY|AUTH[_-]?KEY|BEARER|DSN|APIKEY|PAT)[A-Za-z0-9_]*)\1(\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"'`,;)]{4,})/gi,
    to: (m, quote, key, sep) => `${quote}${key}${quote}${sep}${
      namesASecret(key) ? '[REDACTED]' : redactNamedAssignments(assignedValue([m, quote, key, sep]))}`,
    // Everything after the separator, minus the quotes a quoted value carries.
    secret: (m) => unquote(assignedValue(m)),
  },
  // Connection strings carrying an inline password: postgresql://user:pw@host.
  {
    name: 'connection-string-password',
    re: /\b([a-z][a-z0-9+.-]{2,15}:\/\/)([^\s:@/]{1,64}):([^\s@/]{1,256})@/gi,
    to: (_m, scheme, user) => `${scheme}${user}:[REDACTED]@`,
    secret: (m) => m[3],
  },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, to: '[REDACTED-JWT]' },
  { name: 'supabase-key', re: /\bsb[a-z]{0,12}_[A-Za-z0-9_-]{16,}/g, to: '[REDACTED-KEY]' },
  // `github_pat_…` is GitHub's current default and does not start `gh?_`, so it
  // needs its own rule; without one a pasted fine-grained token passes through.
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, to: '[REDACTED-KEY]' },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, to: '[REDACTED-KEY]' },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}/g, to: '[REDACTED-KEY]' },
  { name: 'stripe-key', re: /\b[sruwp]k_(?:live|test)_[A-Za-z0-9]{16,}/g, to: '[REDACTED-KEY]' },
  { name: 'google-api-key', re: /\bAIza[A-Za-z0-9_-]{30,}/g, to: '[REDACTED-KEY]' },
  { name: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{16,}/g, to: '[REDACTED-KEY]' },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{30,}/g, to: '[REDACTED-KEY]' },
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g, to: '[REDACTED-KEY]' },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, to: '[REDACTED-KEY]' },
  {
    name: 'pem-private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    to: '[REDACTED-PRIVATE-KEY]',
  },
  {
    name: 'bearer-header',
    re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
    to: 'Bearer [REDACTED]',
    secret: (m) => withoutFirstWord(m[0]),
  },
  // `Authorization` matches none of the key names above, so Basic auth needs a
  // rule of its own; the base64 blob is a username and password.
  {
    name: 'basic-header',
    re: /\b([Bb]asic)\s+[A-Za-z0-9+/]{12,}={0,2}/g,
    to: '$1 [REDACTED]',
    secret: (m) => withoutFirstWord(m[0]),
  },
]);

/** Everything after the separator of a named-assignment match, quotes and all. */
function assignedValue(m) {
  return m[0].slice(m[1].length * 2 + m[2].length + m[3].length);
}

/** The named-assignment rule alone, over `text`: for a value a non-secret key carries. */
function redactNamedAssignments(text) {
  const rule = SECRET_RULES.find((candidate) => candidate.name === NAMED_ASSIGNMENT);
  return text.replace(new RegExp(rule.re.source, rule.re.flags), rule.to);
}

function unquote(value) {
  const quote = value[0];
  const quoted = (quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote);
  return quoted ? value.slice(1, -1) : value;
}

function withoutFirstWord(value) {
  return value.replace(/^\S+\s+/, '');
}

/**
 * Redact every known secret shape in `text`.
 *
 * A rule that throws is skipped rather than allowed to lose the whole note:
 * partial redaction of a note is still better than no note, and every rule is
 * independently covered by a test, so a throwing rule is a loud test failure
 * rather than a silent hole.
 */
export function redact(text) {
  if (typeof text !== 'string' || text === '') return '';
  // The built-in rules first, then this machine's own (R-106): an extra rule
  // sees the text after every built-in marker is in place.
  return applyRules(applyRules(text, SECRET_RULES), extraRules);
}

function applyRules(text, rules) {
  let out = text;
  for (const rule of rules) {
    try {
      out = out.replace(rule.re, rule.to);
    } catch {
      /* one bad replace must never cost the whole note */
    }
  }
  return out;
}

/**
 * This machine's extra rules (R-106), applied by `redact()` after SECRET_RULES.
 *
 * Empty until an entry point installs them. The loading and validation of the
 * `HARNESS_REDACT_EXTRA` file live in `redact-extra.mjs`, because this file has
 * no imports and ships as a `/checkpoint` payload file, which never loads extras.
 */
let extraRules = Object.freeze([]);

function isCompiledRule(rule) {
  return Boolean(rule)
    && rule.re instanceof RegExp
    && rule.re.global
    && (typeof rule.to === 'string' || typeof rule.to === 'function');
}

/**
 * Replace the installed extra rules. Each must be `{ name, re, to }` with a
 * global `re`; anything else is left out. Replaces rather than appends, so
 * installing twice never doubles a rule, and `installExtraRules([])` clears.
 *
 * @param {readonly {name: string, re: RegExp, to: string|Function}[]} rules
 * @returns {number} how many rules are now installed
 */
export function installExtraRules(rules) {
  const accepted = (Array.isArray(rules) ? rules : [])
    .filter(isCompiledRule)
    .map((rule) => Object.freeze({ name: String(rule.name ?? ''), re: rule.re, to: rule.to }));
  extraRules = Object.freeze(accepted);
  return extraRules.length;
}

/** The extra rules `redact()` applies now (frozen). */
export function installedExtraRules() {
  return extraRules;
}

/**
 * Below this a literal is not replaced: removing every "abcd" from a paragraph
 * would shred the text and protect nothing.
 */
export const MIN_LITERAL_SECRET_CHARS = 8;

const LITERAL_MARKER = '[REDACTED]';

/**
 * Values that fill a secret's slot without being one. `GITHUB_TOKEN: undefined`
 * pasted while debugging a missing secret must not get every "undefined" in the
 * closing message replaced. The shape rules still redact the assignment itself.
 */
const PLACEHOLDER_VALUES = new Set([
  'undefined', 'password', 'changeme', 'change-me', 'placeholder', 'redacted', 'required',
  'localhost', 'example', 'examples', 'your-key', 'your_key', 'xxxxxxxx', '********',
]);

/** `$TOKEN`, `${{ secrets.X }}`, `%TOKEN%`, `<your-key>`, `process.env.X`: a reference to a secret, not its value. */
const REFERENCE_VALUE = /^(?:[$%<{]|process\.env\b|os\.environ\b|env\.|secrets\.)/i;

function isLiteralSecret(value) {
  if (value.length < MIN_LITERAL_SECRET_CHARS || value.includes(LITERAL_MARKER)) return false;
  return !PLACEHOLDER_VALUES.has(value.toLowerCase()) && !REFERENCE_VALUE.test(value);
}

/**
 * The secret values the rules find in `text` — the password, not the connection
 * string around it; the token, not `GITHUB_TOKEN=`.
 *
 * A rule matches a shape, and a secret repeated in prose has none. Model-written
 * text (the closing message) is where that happens: "rotate the database
 * password hunter2hunter2". So the values seen in a shape anywhere in the
 * session are collected here and removed literally by `redactLiterals`.
 *
 * @returns {string[]} distinct values, each at least MIN_LITERAL_SECRET_CHARS long
 */
export function findSecretValues(text) {
  if (typeof text !== 'string' || text === '') return [];
  const found = new Set();
  for (const rule of SECRET_RULES) {
    try {
      for (const match of text.matchAll(rule.re)) {
        if (rule.name === NAMED_ASSIGNMENT && !namesASecret(match[2])) {
          // `path: …` is not a secret, but its value may hold an assignment that is.
          for (const nested of findSecretValues(assignedValue(match))) found.add(nested);
          continue;
        }
        const value = String(rule.secret ? rule.secret(match) : match[0]).trim();
        if (isLiteralSecret(value)) found.add(value);
      }
    } catch {
      /* as in redact(): one bad rule must not cost the rest */
    }
  }
  return [...found];
}

/**
 * Which rules find a secret in `text`, and where — never the secret itself.
 *
 * The same rules and the same placeholder filter as `findSecretValues`, so a
 * `API_KEY=$API_KEY` in a skill's docs is not a hit here any more than it is a
 * redaction in a note. Built for the claude-config pre-commit scan (R-H5), which
 * must say where a secret is without printing it.
 *
 * `PAT` in a key name counts only as a word (`GITHUB_PAT`, `githubPat`), not
 * as the letters inside `output_path`, `pattern` or `dispatch` — the same
 * reading `redact()` and `findSecretValues` use. A commit gate that fired on
 * every `*_path = …` in a skill's scripts (165 of 180 hits on the real
 * `~/.claude`) could never pass, and a note that lost every `path:` value,
 * and every later mention of it, lost the file names it was about.
 *
 * A rule that throws is where this parts company with `redact()`. There a
 * skipped rule costs a little redaction; here it would be a scan that reports
 * clean without having looked. So the throw is itself a finding,
 * `<rule>:error` at the start of the text, and a commit gate built on this
 * fails closed. The rules that did run keep their own findings.
 *
 * @param {string} text
 * @param {readonly object[]} [rules]  SECRET_RULES; a parameter so a test can inject a broken one
 * @returns {{rule: string, index: number}[]} in rule order, then text order
 */
export function findSecretMatches(text, rules = SECRET_RULES) {
  if (typeof text !== 'string' || text === '') return [];
  return rules.flatMap((rule) => {
    try {
      return ruleMatches(text, rule);
    } catch {
      return [{ rule: `${rule?.name ?? 'unnamed-rule'}:error`, index: 0 }];
    }
  });
}

function ruleMatches(text, rule) {
  const matches = [];
  for (const match of text.matchAll(rule.re)) {
    const value = String(rule.secret ? rule.secret(match) : match[0]).trim();
    if (!isLiteralSecret(value)) continue;
    if (rule.name === NAMED_ASSIGNMENT && !namesASecret(match[2])) continue;
    matches.push({ rule: rule.name, index: match.index });
  }
  return matches;
}

const isLetter = (ch) => /[A-Za-z]/.test(ch ?? '');
const isLower = (ch) => /[a-z]/.test(ch ?? '');
const isUpper = (ch) => /[A-Z]/.test(ch ?? '');

/**
 * Is this `pat` a word of its own? It is at a non-letter boundary on each side,
 * or at a camelCase one: `githubPat` starts a word, `patValue` ends one.
 * `path`, `PATH`, `dispatch`, `COMPATIBILITY` and `videosPath` are embedded.
 */
function patIsAWord(occurrence, before, after) {
  const starts = !isLetter(before) || (occurrence[0] === 'P' && isLower(before));
  const ends = !isLetter(after) || (isUpper(after) && occurrence[2] === 't');
  return starts && ends;
}

/**
 * Does this key name still read as a secret once every embedded `pat` is
 * masked? Re-asks the rule itself, so the keyword list lives in one place.
 */
function namesASecret(key) {
  const name = String(key ?? '');
  const masked = name.replace(/pat/gi, (occurrence, offset) =>
    patIsAWord(occurrence, name[offset - 1], name[offset + 3]) ? occurrence : '#');
  const rule = SECRET_RULES.find((candidate) => candidate.name === NAMED_ASSIGNMENT);
  return new RegExp(rule.re.source, 'i').test(`${masked}=probevalue`);
}

/**
 * Replace every literal occurrence of each value. Longest first, so a value
 * that contains another is removed whole.
 */
export function redactLiterals(text, values) {
  if (typeof text !== 'string' || text === '') return '';
  const ordered = [...new Set(values)]
    .filter((value) => typeof value === 'string' && value.length >= MIN_LITERAL_SECRET_CHARS)
    .sort((a, b) => b.length - a.length);
  return ordered.reduce((out, value) => out.split(value).join(LITERAL_MARKER), text);
}

/**
 * Does `text` still look like it carries a credential?
 *
 * Used by the test suite as an independent check on rendered notes, so a rule
 * that stops matching shows up as a failure instead of as a leak.
 */
export function looksRedacted(text) {
  // Each probe excludes the marker the corresponding rule leaves behind, so a
  // correctly redacted note reads as clean and only a real secret trips it.
  const probes = [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
    /\bsb[a-z]{0,12}_[A-Za-z0-9_-]{16,}/,
    /\bgh[pousr]_[A-Za-z0-9]{16,}/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/,
    /\b[sruwp]k_(?:live|test)_[A-Za-z0-9]{16,}/,
    /\bAIza[A-Za-z0-9_-]{30,}/,
    /\bglpat-[A-Za-z0-9_-]{16,}/,
    /\bnpm_[A-Za-z0-9]{30,}/,
    /:\/\/[^\s:@/]{1,64}:(?!\[REDACTED)[^\s@/]{8,}@/,
    /\b[Bb]asic\s+(?!\[REDACTED)[A-Za-z0-9+/]{12,}={0,2}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];
  return !probes.some((re) => re.test(String(text ?? '')));
}
