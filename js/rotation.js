import { ls } from './storage.js';
// Gemeinsame Blickrichtung für Übersicht und Einzelkarten.
// bearing = Himmelsrichtung, die oben auf dem Bildschirm liegt (0 = Norden, 90 = Osten, 270 = Westen).
const KEY = 'bearing';
let bearing = 0;
bearing = +ls.get(KEY) || 0;
const subs = new Set();

export const getBearing = () => bearing;

export function setBearing(b) {
  bearing = ((b % 360) + 360) % 360;
  if (Math.abs(bearing) < 0.05 || Math.abs(bearing - 360) < 0.05) bearing = 0;
  ls.set(KEY, bearing);
  subs.forEach((f) => f(bearing));
}

export const onBearing = (f) => subs.add(f);

/** Punkt um ein Zentrum drehen (Grad, im Uhrzeigersinn bei y nach unten) */
export function rotPt([x, y], deg, [cx, cy] = [0, 0]) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/** Bildschirmkoordinaten (clientX/Y) in lokale Koordinaten eines SVG-Elements (inkl. dessen Drehung) */
export function clientToLocal(el, x, y) {
  const m = el.getScreenCTM().inverse();
  const p = new DOMPoint(x, y).matrixTransform(m);
  return [p.x, p.y];
}

/** Sanft auf eine Richtung drehen (kürzester Weg) */
let anim = 0;
export function animateBearing(to, ms = 300) {
  cancelAnimationFrame(anim);
  const from = bearing;
  let d = ((to - from + 540) % 360) - 180;
  const t0 = performance.now();
  const step = (t) => {
    const f = Math.min(1, (t - t0) / ms), e = 1 - (1 - f) ** 3;
    setBearing(from + d * e);
    if (f < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

/** Kompass-Knopf: Nadel zeigt nach Norden, sichtbar nur wenn gedreht */
export function updateCompass(btn) {
  if (!btn) return;
  btn.hidden = bearing === 0;
  btn.querySelector('.needle').style.transform = `rotate(${-bearing}deg)`;
}
