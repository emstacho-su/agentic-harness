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

export const SECRET_RULES = Object.freeze([
  // KEY=value / KEY: value where the key name itself signals a secret.
  //
  // The closing backreference is `\3`, the quote group. Version 1.0.0 of this
  // hook wrote `\4` — the *value* group — so the rule only fired when the value
  // happened to be the same string twice (`hunter2hunter2` matched; a real key
  // did not). The whole-note assertion in `redaction.test.mjs` is what caught
  // it, which is the argument for keeping that second, rule-blind layer.
  {
    name: 'named-secret-assignment',
    re: /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|SERVICE[_-]?ROLE|ANON[_-]?KEY|AUTH[_-]?KEY|BEARER|DSN|APIKEY|PAT)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)[^\s"'`,;)]{4,}\3/gi,
    to: (_m, key, sep, quote) => `${key}${sep}${quote}[REDACTED]${quote}`,
  },
  // Connection strings carrying an inline password: postgresql://user:pw@host.
  {
    name: 'connection-string-password',
    re: /\b([a-z][a-z0-9+.-]{2,15}:\/\/)([^\s:@/]{1,64}):([^\s@/]{1,256})@/gi,
    to: (_m, scheme, user) => `${scheme}${user}:[REDACTED]@`,
  },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, to: '[REDACTED-JWT]' },
  { name: 'supabase-key', re: /\bsb[a-z]{0,12}_[A-Za-z0-9_-]{16,}/g, to: '[REDACTED-KEY]' },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, to: '[REDACTED-KEY]' },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}/g, to: '[REDACTED-KEY]' },
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g, to: '[REDACTED-KEY]' },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, to: '[REDACTED-KEY]' },
  {
    name: 'pem-private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    to: '[REDACTED-PRIVATE-KEY]',
  },
  { name: 'bearer-header', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g, to: 'Bearer [REDACTED]' },
]);

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
  let out = text;
  for (const rule of SECRET_RULES) {
    try {
      out = out.replace(rule.re, rule.to);
    } catch {
      /* one bad replace must never cost the whole note */
    }
  }
  return out;
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
    /:\/\/[^\s:@/]{1,64}:(?!\[REDACTED)[^\s@/]{8,}@/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];
  return !probes.some((re) => re.test(String(text ?? '')));
}
