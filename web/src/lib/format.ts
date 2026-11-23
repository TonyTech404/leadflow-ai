const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
export const money = (n: number | null | undefined) => (n == null ? '—' : gbp.format(n));
export const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`);
export const int = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-GB'));

export function minutes(m: number | null | undefined) {
  if (m == null) return '—';
  if (m < 1) return '<1 min';
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
  return `${Math.round(m / 60 / 24)} d`;
}

export function ago(iso: string, now = Date.now()) {
  const s = (now - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const SOURCE_LABEL: Record<string, string> = {
  meta: 'Meta ads', google: 'Google ads', tiktok: 'TikTok ads', linkedin: 'LinkedIn ads', email: 'Email', organic: 'Website', referral: 'Referral',
};
export const STAGE_LABEL: Record<string, string> = {
  new: 'New', contacted: 'Contacted', qualified: 'Qualified', booked: 'Booked', won: 'Won', lost: 'Lost',
};
export const INTENT_LABEL: Record<string, string> = {
  ready_to_buy: 'Ready to buy', comparing_options: 'Comparing options', early_research: 'Early research', not_a_fit: 'Not a fit', spam: 'Spam',
};
export const ROLE_LABEL: Record<string, string> = {
  agency_admin: 'Agency admin', account_manager: 'Account manager', client_viewer: 'Client viewer',
};
