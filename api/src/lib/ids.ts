const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** GoHighLevel-style 20-character ids, for the simulated CRM. */
export function ghlId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function apiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'lf_live_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
