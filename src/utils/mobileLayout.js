/**
 * mobileLayout — pure helpers for the Mobile layout (phone or tablet as the
 * primary display in a go-box or in the field).
 *
 * Everything here is side-effect free and takes its inputs explicitly so it
 * can be unit-tested without a DOM: which panel cards to offer in which
 * order, remembering the last card, deciding when to suggest the layout on a
 * first visit, and turning a scroll position into an active card index.
 */

export const MOBILE_LAYOUT_ID = 'mobile';

/** localStorage keys */
export const MOBILE_CARD_KEY = 'openhamclock_mobileCard';
export const MOBILE_SUGGEST_KEY = 'openhamclock_mobileLayoutSuggested';

/** Viewports no wider than this are "phone-sized" for the auto-suggest. */
export const PHONE_MAX_WIDTH = 600;

/**
 * The full card catalogue, in display order. `panelKey` is the key under
 * config.panels that hides the card when `visible === false` (cards without
 * one are always offered). `when` names a context flag that must be truthy
 * for the card to appear at all.
 */
export const MOBILE_CARD_DEFS = [
  { id: 'dx-cluster', icon: '📻', panelKey: 'dxCluster' },
  { id: 'activations', icon: '▲', panelKey: 'pota' },
  { id: 'propagation', icon: '📡', panelKey: 'propagation' },
  { id: 'solar', icon: '☀️', panelKey: 'solar' },
  { id: 'satellites', icon: '🛰️', panelKey: 'satellites' },
  { id: 'logbook', icon: '📓', panelKey: 'logbook' },
  { id: 'weather', icon: '🌦️', panelKey: 'weather' },
  { id: 'psk', icon: '📶', panelKey: 'pskReporter' },
  { id: 'aprs', icon: '📍', panelKey: 'aprs', when: 'showAPRS' },
];

/**
 * Which cards to show, in order, for the current context.
 *
 * @param {object} opts
 * @param {object} [opts.panels]   config.panels — `{ key: { visible } }`
 * @param {boolean} [opts.showAPRS] the APRS map layer is on (APRS card)
 * @returns {{ id: string, icon: string }[]}
 */
export function buildMobileCards({ panels = {}, showAPRS = false } = {}) {
  const flags = { showAPRS: !!showAPRS };
  return MOBILE_CARD_DEFS.filter((def) => {
    if (def.when && !flags[def.when]) return false;
    if (def.panelKey && panels?.[def.panelKey]?.visible === false) return false;
    return true;
  }).map(({ id, icon }) => ({ id, icon }));
}

/**
 * Index of the remembered card inside `cards`, or 0 when nothing (valid) is
 * remembered. Tolerates a missing/broken storage object.
 */
export function readLastCardIndex(storage, cards) {
  let id = null;
  try {
    id = storage?.getItem?.(MOBILE_CARD_KEY) ?? null;
  } catch {
    id = null;
  }
  if (!id || !Array.isArray(cards)) return 0;
  const idx = cards.findIndex((c) => c.id === id);
  return idx >= 0 ? idx : 0;
}

/** Remember `cardId` as the last card. Silently ignores storage failures. */
export function writeLastCard(storage, cardId) {
  try {
    if (cardId) storage?.setItem?.(MOBILE_CARD_KEY, String(cardId));
    else storage?.removeItem?.(MOBILE_CARD_KEY);
  } catch {
    /* private mode / quota — the choice just isn't remembered */
  }
}

/**
 * Which card is centred for a given horizontal scroll offset. Each card is
 * `cardWidth` wide with `gap` between cards; the result is clamped to the
 * card count so an over-scroll bounce never produces an invalid index.
 */
export function cardIndexFromScroll(scrollLeft, cardWidth, gap = 0, count = 1) {
  if (!(count > 0)) return 0;
  const stride = cardWidth + gap;
  if (!(stride > 0)) return 0;
  const idx = Math.round(scrollLeft / stride);
  return Math.min(Math.max(idx, 0), count - 1);
}

/** Scroll offset that centres card `index` (inverse of cardIndexFromScroll). */
export function scrollLeftForCard(index, cardWidth, gap = 0) {
  return Math.max(0, index) * (cardWidth + gap);
}

/** Phone-sized viewport: narrow in its current orientation, or a phone held sideways. */
export function isPhoneViewport(width, height) {
  if (!(width > 0)) return false;
  if (width <= PHONE_MAX_WIDTH) return true;
  // Landscape phone: short side is phone-sized and it is clearly wider than tall
  return height > 0 && height <= 480 && width <= 1000;
}

/**
 * Should we offer the Mobile layout right now?
 *
 * Only on a first visit (no saved config yet), on a phone-sized viewport,
 * when the user has not already picked the Mobile layout, and never twice:
 * once shown — accepted or dismissed — the offer is remembered.
 */
export function shouldSuggestMobileLayout({
  width,
  height,
  layout,
  firstVisit = false,
  alreadySuggested = false,
} = {}) {
  if (!firstVisit || alreadySuggested) return false;
  if (layout === MOBILE_LAYOUT_ID) return false;
  return isPhoneViewport(width, height);
}

/**
 * Has a layout ever been saved? `raw` is the stored openhamclock_config
 * string. A missing key is not enough to detect a first visit: the theme
 * module stores `{ theme, customTheme }` under the same key on first load,
 * so the test is whether a `layout` was ever written.
 */
export function hasSavedLayout(raw) {
  if (!raw) return false;
  try {
    const cfg = JSON.parse(raw);
    return !!(cfg && typeof cfg === 'object' && typeof cfg.layout === 'string' && cfg.layout);
  } catch {
    return false;
  }
}

/** Has the offer already been made on this device? */
export function readSuggestionDone(storage) {
  try {
    return storage?.getItem?.(MOBILE_SUGGEST_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember that the offer was made (accepted or dismissed). */
export function markSuggestionDone(storage) {
  try {
    storage?.setItem?.(MOBILE_SUGGEST_KEY, '1');
  } catch {
    /* ignore */
  }
}

/** True inside an installed PWA (standalone / fullscreen display mode). */
export function isStandaloneDisplay(win) {
  if (!win) return false;
  try {
    if (win.navigator?.standalone === true) return true; // iOS Safari
    const mm = win.matchMedia;
    if (typeof mm !== 'function') return false;
    return !!(
      mm.call(win, '(display-mode: standalone)')?.matches || mm.call(win, '(display-mode: fullscreen)')?.matches
    );
  } catch {
    return false;
  }
}

/** Landscape when the viewport is wider than it is tall (and not a tiny square). */
export function isLandscape(width, height) {
  return width > 0 && height > 0 && width > height;
}

/**
 * Map height for the portrait arrangement: a usable slice of the viewport
 * that still leaves the card row readable. Clamped between 200 and 420 px.
 */
export function portraitMapHeight(viewportHeight) {
  if (!(viewportHeight > 0)) return 260;
  return Math.round(Math.min(420, Math.max(200, viewportHeight * 0.4)));
}
