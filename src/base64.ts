/** Base64 for JSON transport; the uplink to the host accepts only lossless JSON values, never raw bytes. */
export function toBase64(data: Uint8Array): string {
  let binary = ''; for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(binary);
}
export function fromBase64(value: string): Uint8Array { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
