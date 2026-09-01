export function formatAgo(t, at) {
  if (!at) return '';
  const sec = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (sec < 60) return t('justNow');
  if (sec < 3600) return t('minutesAgo').replace('{n}', String(Math.round(sec / 60)));
  return t('hoursAgo').replace('{n}', String(Math.round(sec / 3600)));
}

export function nextKeyRef(providerId, existingKeys, allRefs) {
  const fromExisting = (existingKeys || []).find((k) => typeof k === 'string' && k.length > 0);
  const base = fromExisting
    ? fromExisting.replace(/_\d+$/, '')
    : String(providerId || 'provider').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '_API_KEY';
  const taken = new Set(allRefs);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = base + '_' + n;
    if (!taken.has(candidate)) return candidate;
  }
  return base + '_' + Date.now();
}
