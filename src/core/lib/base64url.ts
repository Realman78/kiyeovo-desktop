/**
 * Convert buffer to base64url (URL-safe base64)
 * Replaces / with -, + with _, and removes = padding
 */
export function toBase64Url(buffer: Uint8Array): string {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Convert base64url to buffer
 */
export function fromBase64Url(base64url: string): Uint8Array {
  // Add back padding if needed
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64');
}
