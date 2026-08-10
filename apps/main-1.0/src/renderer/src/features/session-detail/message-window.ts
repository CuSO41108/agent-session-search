export const INITIAL_MESSAGE_LIMIT = 20;
export const MESSAGE_PAGE_SIZE = 80;

export function initialMessageWindow(
  messageCount: number,
  matchedMessageIndex: number | null,
): { offset: number; limit: number } {
  const count = Math.max(0, messageCount);
  const limit = matchedMessageIndex === null ? INITIAL_MESSAGE_LIMIT : MESSAGE_PAGE_SIZE;
  const latestOffset = Math.max(0, count - limit);
  if (matchedMessageIndex === null) return { offset: latestOffset, limit };

  const centeredOffset = Math.max(0, matchedMessageIndex - Math.floor(limit / 2));
  return {
    offset: Math.min(centeredOffset, latestOffset),
    limit,
  };
}
