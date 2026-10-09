/** Both callers validate their own total length and maximum grapheme first. */
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
