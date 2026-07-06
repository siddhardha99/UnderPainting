/**
 * Minimal incremental SSE parser for OpenRouter's streaming responses.
 * Feed it decoded text in arbitrary chunk sizes; it returns the complete
 * `data:` payloads found so far and buffers partial lines. Comment lines
 * (": OPENROUTER PROCESSING" keep-alives) are ignored.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const payloads: string[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.startsWith('data: ')) {
        payloads.push(line.slice(6));
      } else if (line.startsWith('data:')) {
        payloads.push(line.slice(5));
      }
      // Everything else (comments, blank separators, event names) is ignored.
    }
    return payloads;
  }
}
