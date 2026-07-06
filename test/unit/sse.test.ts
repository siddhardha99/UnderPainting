import { describe, expect, it } from 'vitest';
import { SseParser } from '../../src/host/client/sse';

describe('SseParser', () => {
  it('parses complete data lines', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\n\ndata: {"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('buffers lines split across arbitrary chunk boundaries', () => {
    const parser = new SseParser();
    expect(parser.push('da')).toEqual([]);
    expect(parser.push('ta: {"a"')).toEqual([]);
    expect(parser.push(':1}\nda')).toEqual(['{"a":1}']);
    expect(parser.push('ta: [DONE]\n')).toEqual(['[DONE]']);
  });

  it('ignores comments, event names, and blank lines', () => {
    const parser = new SseParser();
    const payloads = parser.push(': OPENROUTER PROCESSING\n\nevent: message\ndata: x\n\n');
    expect(payloads).toEqual(['x']);
  });

  it('handles CRLF line endings', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\r\n\r\n')).toEqual(['{"a":1}']);
  });

  it('accepts data: without a space', () => {
    const parser = new SseParser();
    expect(parser.push('data:{"a":1}\n')).toEqual(['{"a":1}']);
  });
});
