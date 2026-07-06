import * as crypto from 'node:crypto';

/**
 * Minimal ULID generator (~20 lines beats a dependency, §4): 48-bit
 * millisecond timestamp + 80 bits of crypto randomness, Crockford base32.
 * Lexicographic order therefore follows creation time, which is all the
 * version store needs from its IDs.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.randomBytes(10);
  let random = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      random += ALPHABET[(acc >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  return time + random.slice(0, 16);
}
