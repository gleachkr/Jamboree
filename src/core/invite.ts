// Invite URL handling for Jamboree rooms.
//
// Format: <origin><base>r/<room-id>#key=<secret>
//
// The room key is high-entropy random material kept in the URL fragment so it
// is never sent to the static host in HTTP requests. The room id is public
// routing material; possession of the key is the room capability.

const KEY_BYTES = 32;
const KEY_PARAM = 'key';

const ADJECTIVES = [
  'quiet', 'loud', 'bright', 'dark', 'swift', 'slow', 'calm', 'wild',
  'soft', 'bold', 'fuzzy', 'sharp', 'warm', 'cool', 'deep', 'high',
  'sunny', 'misty', 'cosmic', 'gentle',
];

const NOUNS = [
  'moon', 'river', 'forest', 'mountain', 'ocean', 'valley', 'garden', 'meadow',
  'comet', 'ember', 'harbor', 'lantern', 'cabin', 'aurora', 'horizon', 'summit',
  'jungle', 'desert', 'prairie', 'thicket',
];

export type RoomInvite = {
  roomId: string;
  key: string;
};

export function generateRoomKey(): string {
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function generateRoomId(): string {
  return `${pickRandom(ADJECTIVES)}-${pickRandom(NOUNS)}`;
}

export function generateInvite(): RoomInvite {
  return { roomId: generateRoomId(), key: generateRoomKey() };
}

export function createInviteUrl(invite: RoomInvite, baseUrl: string): string {
  const url = new URL(`r/${encodeURIComponent(invite.roomId)}`, ensureTrailingSlash(baseUrl));
  url.hash = `${KEY_PARAM}=${encodeURIComponent(invite.key)}`;
  return url.toString();
}

export function parseInviteUrl(input: string): RoomInvite | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  return parseInviteFromParts(url.pathname, url.hash);
}

export function parseInviteFromParts(pathname: string, hash: string): RoomInvite | null {
  const match = pathname.match(/(?:^|\/)r\/([^/]+)\/?$/);
  if (!match) return null;
  const roomId = safeDecode(match[1]);
  if (!roomId) return null;

  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(fragment);
  const rawKey = params.get(KEY_PARAM);
  if (!rawKey) return null;

  return { roomId, key: rawKey };
}

function pickRandom<T>(items: readonly T[]): T {
  const idx = Math.floor(Math.random() * items.length);
  return items[idx]!;
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
