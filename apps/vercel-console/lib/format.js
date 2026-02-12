export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '--';
  }
  return date.toLocaleString();
}

export function hoursSince(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 0;
  }
  return Math.max(0, (Date.now() - date.getTime()) / 36e5);
}

export function agingClass(iso) {
  const hours = hoursSince(iso);
  if (hours >= 24) {
    return 'age-high';
  }
  if (hours >= 8) {
    return 'age-medium';
  }
  return '';
}

export function statusPillClass(signal, lane) {
  if (signal === 'passing' || lane === 'done') {
    return 'ok';
  }
  if (signal === 'failing' || lane === 'blocked') {
    return 'danger';
  }
  return 'warn';
}
