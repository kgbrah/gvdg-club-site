export function safeExternalUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

if (typeof window !== 'undefined') {
  window.GVDGSafeUrl = safeExternalUrl;
}
