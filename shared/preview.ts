export const PREVIEW_CHANNEL = 'geomsupin:review-preview';

export function isPreviewMessage(value: unknown, id: string) {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return message.channel === PREVIEW_CHANNEL && message.id === id;
}
