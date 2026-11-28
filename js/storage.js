// Einstellungen im localStorage – immer mit eigenem Präfix, weil mehrere Apps unter
// dersauerlaender.github.io denselben Speicher teilen (z. B. OpenMixedRation).
export const NS = 'mulchkarten:';

// Schlüssel aus Versionen ≤ 1.13 (ohne Präfix) – werden einmalig übernommen, aber nicht gelöscht,
// falls eine andere App zufällig denselben Namen nutzt.
// Je Schlüssel eine Prüfung, damit kein fremder Wert gleichen Namens übernommen wird.
const LEGACY = new Map([
  ['bearing', (v) => /^\d+(\.\d+)?$/.test(v) && +v < 360],
  ['ov-tiles', (v) => v === '0' || v === '1'],
  ['ov-lines', (v) => v === '0' || v === '1'],
  ['ov-prefs', (v) => { try { const o = JSON.parse(v); return o && typeof o === 'object' && Object.keys(o).every((k) => /^[0-9a-f]{20}$/.test(k)); } catch { return false; } }],
  ['f-season', (v) => /^(\d{2}\/\d{2}|alle)$/.test(v)],
  ['f-revier', (v) => typeof v === 'string' && v.length < 80],
  ['f-hidedone', (v) => v === '' || v === '1'],
]);

export const ls = {
  get(key, def = null) {
    try {
      const v = localStorage.getItem(NS + key);
      if (v !== null) return v;
      if (LEGACY.has(key) && !localStorage.getItem(NS + 'migrated:' + key)) {
        const old = localStorage.getItem(key);
        localStorage.setItem(NS + 'migrated:' + key, '1');
        if (old !== null && LEGACY.get(key)(old)) { localStorage.setItem(NS + key, old); return old; }
      }
    } catch { /* Speicher gesperrt */ }
    return def;
  },
  set(key, value) {
    try { localStorage.setItem(NS + key, String(value)); } catch { /* egal */ }
  },
};

// Namen der Zwischenspeicher (Cache API) – ebenfalls mit Präfix
export const CACHE_PREFIX = 'mulchkarten-';
export const INBOX_CACHE = 'mulchkarten-share-inbox';
