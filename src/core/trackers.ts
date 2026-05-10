// Shared tracker list for both Trystero (rendezvous signaling) and
// WebTorrent (content). Trystero's defaults and WebTorrent's defaults both
// include trackers that are intermittently or permanently down
// (tracker.btorrent.xyz returns no DNS; tracker.webtorrent.dev refuses
// connections from many networks). Pinning to a smaller, currently-reliable
// set avoids minutes of WebSocket connection-refused noise per page load.
//
// Revisit periodically — public WebTorrent trackers come and go. If two of
// these die we should add another rather than just live with one.

export const WSS_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
];
