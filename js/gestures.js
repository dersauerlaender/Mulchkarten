// Ein-Finger-Zoom wie bei Google Maps:
//  - Doppeltippen: eine Stufe hineinzoomen (an der Stelle)
//  - Doppeltippen und beim zweiten Tipp ziehen: runter = größer, hoch = kleiner
const d3 = window.d3;

const TAP_MS = 250;      // so kurz muss ein Tipp sein
const DOUBLE_MS = 320;   // max. Abstand zwischen den beiden Tipps
const NEAR_PX = 35;      // max. Abstand der beiden Tipps
const MOVE_PX = 10;      // darunter gilt es als Tipp, nicht als Ziehen

/**
 * @param svgSel  d3-Auswahl des <svg>
 * @param zoom    d3.zoom-Verhalten, das auf svgSel liegt
 * @param opts    { enabled(): bool, onStart(): void }
 * @returns       { busy(): bool  – Geste läuft oder lief gerade (Klicks ignorieren) }
 */
export function oneFingerZoom(svgSel, zoom, opts = {}) {
  const node = svgSel.node();
  const enabled = opts.enabled || (() => true);
  let down = null;       // aktueller Fingerdruck {id, x, y, t}
  let lastTap = null;    // letzter kurzer Tipp {x, y, t}
  let g = null;          // laufende Doppeltipp-Geste {id, px, py, y0, t0, moved}
  let endedAt = 0;
  let pointers = 0;

  // d3 soll während der Geste nicht verschieben
  const f0 = zoom.filter();
  zoom.filter(function (ev) { return !g && f0.call(this, ev); });
  svgSel.on('dblclick.zoom', null);   // Doppelklick übernehmen wir selbst

  const local = (e) => {
    const r = node.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  function apply(k, animate) {
    const [kMin, kMax] = zoom.scaleExtent();
    k = Math.max(kMin, Math.min(kMax, k));
    const t0 = g.t0, f = k / t0.k;
    const t = d3.zoomIdentity.translate(g.px - (g.px - t0.x) * f, g.py - (g.py - t0.y) * f).scale(k);
    (animate ? svgSel.transition().duration(250) : svgSel).call(zoom.transform, t);
  }

  node.addEventListener('pointerdown', (e) => {
    pointers++;
    if (pointers > 1) { g = null; return; }           // zweiter Finger: normales Pinch-Zoom
    if (!enabled()) return;
    const [x, y] = local(e);
    const now = Date.now();
    if (lastTap && now - lastTap.t < DOUBLE_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < NEAR_PX) {
      g = { id: e.pointerId, px: lastTap.x, py: lastTap.y, y0: y, t0: d3.zoomTransform(node), moved: false };
      lastTap = null;
      node.setPointerCapture?.(e.pointerId);
      opts.onStart?.();
      return;
    }
    down = { id: e.pointerId, x, y, t: now };
  }, true);

  node.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const [, y] = local(e);
    const dy = y - g.y0;
    if (!g.moved && Math.abs(dy) < MOVE_PX) return;
    g.moved = true;
    apply(g.t0.k * Math.exp(dy / 120), false);
    e.preventDefault();
  }, true);

  const up = (e) => {
    pointers = Math.max(0, pointers - 1);
    if (g && e.pointerId === g.id) {
      if (!g.moved && e.type === 'pointerup') apply(g.t0.k * 2, true);   // einfacher Doppeltipp
      g = null;
      endedAt = Date.now();
      return;
    }
    if (down && e.pointerId === down.id && e.type === 'pointerup') {
      const [x, y] = local(e);
      if (Date.now() - down.t < TAP_MS && Math.hypot(x - down.x, y - down.y) < MOVE_PX) lastTap = { x, y, t: Date.now() };
      else lastTap = null;
    }
    down = null;
  };
  node.addEventListener('pointerup', up, true);
  node.addEventListener('pointercancel', up, true);

  return {
    busy: () => !!g || Date.now() - endedAt < 400,
    /** true, solange ein zweiter Tipp noch zur Doppeltipp-Geste werden kann */
    pending: () => !!lastTap && Date.now() - lastTap.t < DOUBLE_MS,
    DOUBLE_MS,
  };
}
