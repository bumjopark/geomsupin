/** Only an opposite-protocol installation's home page can be advertised. */
export function peerReviewOrigin(publicUrl, peerUrl) {
  const value = peerUrl?.trim();
  if (!value) return null;
  if (!/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(value)) {
    throw new Error('PEER_REVIEW_URL must be an HTTP(S) origin without credentials, a path, query, or fragment.');
  }
  const peer = new URL(value);
  const protocol = new URL(publicUrl).protocol;
  if (peer.protocol !== (protocol === 'https:' ? 'http:' : 'https:')) {
    throw new Error('PEER_REVIEW_URL must use the opposite protocol from PUBLIC_URL.');
  }
  return peer.origin;
}
