// Time formatting helpers. The OS stores all timestamps as UTC ISO 8601
// (per `standard-log-formats`) — these helpers format them for display in
// the user's local timezone.

const ABSOLUTE_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
};

const ABSOLUTE_NO_SECONDS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
};

// "May 20, 2026, 5:18:22 PM PDT" — local timezone of the browser
export function formatLocal(iso: string | null | undefined, withSeconds = true): string {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString(
      undefined,
      withSeconds ? ABSOLUTE_FORMAT : ABSOLUTE_NO_SECONDS,
    );
  } catch {
    return iso;
  }
}

// "2 min ago", "3 hours ago", "yesterday", "5 days ago". For very recent
// (< 5 sec) returns "just now".
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const seconds = Math.floor((now - t) / 1000);

  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}
