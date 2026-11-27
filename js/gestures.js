// Ein-Finger-Zoom wie bei Google Maps:
//  - Doppeltippen: eine Stufe hineinzoomen (an der Stelle)
//  - Doppeltippen und beim zweiten Tipp ziehen: runter = größer, hoch = kleiner
import { rotPt, clientToLocal } from './rotation.js';
const d3 = window.d3;

const TAP_MS = 250;      // so kurz muss ein Tipp sein
const DOUBLE_MS = 320;   // max. Abstand zwischen den beiden Tipps
const NEAR_PX = 35;      // max. Abstand der beiden Tipps
const MOVE_PX = 10;      // darunter gilt es als Tipp, nicht als Ziehen

/**
 * @param svgSel  d3-Auswahl des <svg> (Ereignisse)
 * @param zoom    d3.zoom-Verhalten
 * @param opts    { enabled(): bool, onStart(): void, zoomSel: Element mit dem Zoom (Standard: svgSel) }
 * @returns       { busy(): bool  – Geste läuft oder lief gerade (Klicks ignorieren) }
 */
export function oneFingerZoom(svgSel, zoom, opts = {}) {
  const node = svgSel.node();
  const zsel = opts.zoomSel || svgSel, znode = zsel.node();
  const enabled = opts.enabled || (() => true);
  let down = null;       // aktueller Fingerdruck {id, x, y, t}
  let lastTap = null;    // letzter kurzer Tipp {x, y, t}
  let g = null;          // laufende Doppeltipp-Geste {id, px, py, y0, t0, moved}
  let endedAt = 0;
  let pointers = 0;

  // d3 soll während der Geste nicht verschieben
  const f0 = zoom.filter();
  zoom.filter(function (ev) { return !g && f0.call(this, ev); });
  zsel.on('dblclick.zoom', null);   // Doppelklick übernehmen wir selbst

  // lokale Koordinaten des Zoom-Elements (berücksichtigt eine Drehung)
  const local = (e) => clientToLocal(znode, e.clientX, e.clientY);

  function apply(k, animate) {
    const [kMin, kMax] = zoom.scaleExtent();
    k = Math.max(kMin, Math.min(kMax, k));
    const t0 = g.t0, f = k / t0.k;
    const t = d3.zoomIdentity.translate(g.px - (g.px - t0.x) * f, g.py - (g.py - t0.y) * f).scale(k);
    (animate ? zsel.transition().duration(250) : zsel).call(zoom.transform, t);
  }

  node.addEventListener('pointerdown', (e) => {
    pointers++;
    if (pointers > 1) { g = null; return; }           // zweiter Finger: normales Pinch-Zoom
    if (!enabled()) return;
    const [x, y] = local(e);
    const now = Date.now();
    if (lastTap && now - lastTap.t < DOUBLE_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < NEAR_PX) {
      g = { id: e.pointerId, px: lastTap.x, py: lastTap.y, y0: e.clientY, t0: d3.zoomTransform(znode), moved: false };
      lastTap = null;
      node.setPointerCapture?.(e.pointerId);
      opts.onStart?.();
      return;
    }
    down = { id: e.pointerId, x, y, t: now };
  }, true);

  node.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dy = e.clientY - g.y0;   // Bildschirm-senkrecht, unabhängig von der Drehung
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

/**
 * Zwei Finger: zoomen, verschieben und – ab ~12° Verdrehung – drehen.
 * Übernimmt Zwei-Finger-Gesten komplett (d3 bekommt sie nicht).
 * @param svgNode  das <svg> (Ereignisse, Bildschirmbezug)
 * @param zsel     d3-Auswahl des gedrehten Elements, auf dem der Zoom liegt
 * @param opts     { getR(): Grad, setR(Grad), onStart(), onEnd() }
 */
export function twoFinger(svgNode, zsel, zoom, opts) {
  const ROT_START = 12;
  let g = null, blockRest = false;
  const pt = (t) => { const r = svgNode.getBoundingClientRect(); return [t.clientX - r.left, t.clientY - r.top]; };
  const byId = (list, id) => { for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i]; return null; };
  const center = () => { const r = svgNode.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };

  svgNode.addEventListener('touchstart', (e) => {
    if (e.touches.length < 2) return;
    e.stopPropagation();
    if (g) return;
    const ids = [e.touches[0].identifier, e.touches[1].identifier];
    const a = pt(e.touches[0]), b = pt(e.touches[1]);
    const c0 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const r0 = opts.getR(), t0 = d3.zoomTransform(zsel.node()), C = center();
    g = {
      ids, c0, d0: Math.hypot(b[0] - a[0], b[1] - a[1]) || 1,
      a0: Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI,
      r0, t0, C, rotating: false, off: 0,
      P: t0.invert(rotPt(c0, -r0, C)),   // Kartenpunkt unter der Fingermitte
    };
    opts.onStart?.();
  }, { capture: true, passive: true });

  svgNode.addEventListener('touchmove', (e) => {
    if (!g && !blockRest) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    if (!g || e.touches.length < 2) return;
    // Finger über ihre Kennung zuordnen – die Reihenfolge in e.touches ist nicht verlässlich
    const ta = byId(e.touches, g.ids[0]), tb = byId(e.touches, g.ids[1]);
    if (!ta || !tb) return;
    const a = pt(ta), b = pt(tb);
    const c1 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const d1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let da = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI - g.a0;
    da = ((da + 540) % 360) - 180;
    if (!g.rotating && Math.abs(da) > ROT_START) { g.rotating = true; g.off = Math.sign(da) * ROT_START; }
    const r = g.rotating ? g.r0 + da - g.off : g.r0;
    const [kMin, kMax] = zoom.scaleExtent();
    const k = Math.max(kMin, Math.min(kMax, g.t0.k * d1 / g.d0));
    const L = rotPt(c1, -r, g.C);
    if (r !== opts.getR()) opts.setR(r);
    zsel.call(zoom.transform, d3.zoomIdentity.translate(L[0] - k * g.P[0], L[1] - k * g.P[1]).scale(k));
  }, { capture: true, passive: false });

  const end = (e) => {
    const gone = g && [...e.changedTouches].some((t) => g.ids.includes(t.identifier));
    if (g && (e.touches.length < 2 || gone)) {
      g = null;
      blockRest = e.touches.length > 0;   // verbleibender Finger soll nicht plötzlich verschieben
      opts.onEnd?.();
    } else if (blockRest && e.touches.length === 0) blockRest = false;
  };
  svgNode.addEventListener('touchend', end, { capture: true });
  svgNode.addEventListener('touchcancel', end, { capture: true });

  // Am PC: Umschalt + Mausrad dreht
  svgNode.addEventListener('wheel', (e) => {
    if (!e.shiftKey) return;
    e.stopPropagation();
    e.preventDefault();
    opts.setR(opts.getR() - (e.deltaY || e.deltaX) * 0.15);
    opts.onEnd?.();
  }, { capture: true, passive: false });

  return { active: () => !!g };
}
