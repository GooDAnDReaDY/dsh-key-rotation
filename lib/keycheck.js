// lib/keycheck.js - token leak detector (#200).
// Recognizes live API-key shapes so a real secret pasted into a wrong field
// (webhook URL, provider name, ...) is caught before it leaves the machine.
const PATTERNS = [
  { type: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { type: 'openai', re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/ },
  { type: 'google', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { type: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { type: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { type: 'slack', re: /\bxox[bpars]-[A-Za-z0-9-]{10,}\b/ },
  { type: 'telegram', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/ },
  { type: 'stripe', re: /\b(sk|pk)_(live|test)_[A-Za-z0-9]{20,}\b/ },
  { type: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/** All secrets found in `text`: [{ type, index, preview }]. Preview = first 8 chars only. */
export function findSecrets(text) {
  const out = [];
  const s = String(text ?? '');
  for (const { type, re } of PATTERNS) {
    for (const m of s.matchAll(new RegExp(re.source, 'g'))) {
      out.push({ type, index: m.index, preview: m[0].slice(0, 8) + '…' });
    }
  }
  return out;
}

/** True when the value itself looks like a live credential (for PUT /key sanity hint). */
export function looksLikeApiSecret(value) {
  return findSecrets(value).length > 0;
}
