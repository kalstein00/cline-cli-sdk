/** Callers validate their own total length and maximum grapheme first. */
export function validComposerText(text: unknown): text is string {
  return typeof text === 'string' && !!text && text.trim() === text && Buffer.byteLength(text) <= 112 &&
    !/[\p{Cc}\p{Cs}]/u.test(text) && !text.startsWith('/') && !text.includes('@') &&
    ![...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].some(({segment})=>Buffer.byteLength(segment)>64);
}

export function inputChunks(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (Buffer.byteLength(chunk + segment) > 64) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += segment;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
