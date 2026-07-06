/**
 * Defensive extraction of the HTML document from a (possibly partial) model
 * response. The core prompt forbids markdown fences and commentary, but a
 * model that ignores that must not corrupt the canvas. Works on incomplete
 * buffers: it is called on every streamed chunk.
 */
export function extractHtml(raw: string): string {
  let s = raw.replace(/^﻿/, '').trimStart();
  if (s.startsWith('```')) {
    const newline = s.indexOf('\n');
    if (newline === -1) {
      return ''; // fence line still streaming; nothing renderable yet
    }
    s = s.slice(newline + 1);
  }
  // Strip a trailing fence only when nothing but whitespace follows it.
  const lastFence = s.lastIndexOf('```');
  if (lastFence !== -1 && s.slice(lastFence + 3).trim() === '') {
    s = s.slice(0, lastFence);
  }
  // Drop any leading prose before the document starts.
  const start = s.search(/<!doctype|<html|<[a-z]/i);
  if (start > 0) {
    s = s.slice(start);
  } else if (start === -1) {
    return '';
  }
  return s;
}
