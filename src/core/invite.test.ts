import { describe, it, expect } from 'vitest';
import {
  createInviteUrl,
  generateInvite,
  generateRoomId,
  generateRoomKey,
  parseInviteFromParts,
  parseInviteUrl,
} from './invite.ts';

describe('invite URL roundtrip', () => {
  it('parses what it generates', () => {
    const invite = { roomId: 'quiet-moon', key: 'abc123' };
    const url = createInviteUrl(invite, 'https://jamboree.app/');
    expect(parseInviteUrl(url)).toEqual(invite);
  });

  it('places the key in the fragment, not the query', () => {
    const url = createInviteUrl({ roomId: 'a', key: 'k' }, 'https://x.test/');
    expect(url).toContain('#key=k');
    expect(new URL(url).search).toBe('');
  });

  it('handles a non-root base path (GitHub Pages style)', () => {
    const url = createInviteUrl(
      { roomId: 'misty-cabin', key: 'xyz' },
      'https://gleachkr.github.io/Jamboree/',
    );
    expect(url).toBe('https://gleachkr.github.io/Jamboree/r/misty-cabin#key=xyz');
    expect(parseInviteUrl(url)).toEqual({ roomId: 'misty-cabin', key: 'xyz' });
  });

  it('preserves a key that needs URL-encoding', () => {
    const invite = { roomId: 'cosmic-river', key: 'a/b+c=d' };
    const url = createInviteUrl(invite, 'https://x.test/');
    expect(parseInviteUrl(url)).toEqual(invite);
  });
});

describe('parseInviteUrl rejection cases', () => {
  it('returns null for malformed URLs', () => {
    expect(parseInviteUrl('not a url')).toBeNull();
  });

  it('returns null when there is no /r/<id> segment', () => {
    expect(parseInviteUrl('https://x.test/#key=abc')).toBeNull();
    expect(parseInviteUrl('https://x.test/rooms/foo#key=abc')).toBeNull();
  });

  it('returns null when the key fragment is missing', () => {
    expect(parseInviteUrl('https://x.test/r/foo')).toBeNull();
    expect(parseInviteUrl('https://x.test/r/foo#other=1')).toBeNull();
  });
});

describe('parseInviteFromParts', () => {
  it('reads pathname + hash directly (matches window.location shape)', () => {
    expect(parseInviteFromParts('/Jamboree/r/cosmic-comet', '#key=abc')).toEqual({
      roomId: 'cosmic-comet',
      key: 'abc',
    });
  });
});

describe('generators', () => {
  it('produces distinct, sufficiently long keys', () => {
    const a = generateRoomKey();
    const b = generateRoomKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces room ids in adjective-noun shape', () => {
    expect(generateRoomId()).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('generateInvite returns a usable invite', () => {
    const invite = generateInvite();
    const url = createInviteUrl(invite, 'https://x.test/');
    expect(parseInviteUrl(url)).toEqual(invite);
  });
});
