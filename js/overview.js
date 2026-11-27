// Übersichtskarte: alle Kartenrahmen (nach Status gefärbt), Vorschaubilder der PDFs,
// optional OpenStreetMap-Hintergrund (nur online), eigene Position.
import { makeTransform, inPolygon } from './georef.js';
import { oneFingerZoom, twoFinger } from './gestures.js';
import { getBearing, setBearing, onBearing, rotPt, animateBearing, updateCompass } from './rotation.js';

const d3 = window.d3;
const TILE = 256;
const STATUS_COLOR = { offen: '#64748b', arbeit: '#d97706', fertig: '#16a34a' };

// Web-Mercator in "Welt-Pixel" (0..256 bei Zoom 0)
const toWorld = ([lat, lon]) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * TILE, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE];
};
const fromWorld = ([x, y]) => [
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / TILE))) * 180) / Math.PI,
  (x / TILE) * 360 - 180,
];

export function initOverview(ctx) {
  const svg = d3.select('#ov-svg');
  const defs = svg.append('defs');
  // gRot: Drehung um die Bildschirmmitte, darauf liegt der Zoom (lokale Koordinaten = ungedreht)
  const gRot = svg.append('g').attr('class', 'rot');
  gRot.append('rect').attr('x', -20000).attr('y', -20000).attr('width', 40000).attr('height', 40000)
    .attr('fill', 'none').attr('pointer-events', 'all');
  const gTiles = gRot.append('g');
  const gThumbs = gRot.append('g');
  const gFoot = gRot.append('g');
  const gLines = gRot.append('g').attr('pointer-events', 'none');
  const gLabels = gRot.append('g').attr('pointer-events', 'none');
  const gPoi = gRot.append('g').attr('pointer-events', 'none');
  const gPick = gRot.append('g').attr('pointer-events', 'none');
  const gPos = gRot.append('g').attr('pointer-events', 'none');
  const rot = () => -getBearing();                       // Drehwinkel auf dem Bildschirm
  const center = () => { const r = size(); return [r.width / 2, r.height / 2]; };
  const toScreen = (p) => rotPt(p, rot(), center());     // lokal -> Bildschirm
  const toLocal = (p) => rotPt(p, -rot(), center());     // Bildschirm -> lokal
  let pick = null;   // angetippte Stelle (Stecknadel), solange das Fenster offen ist
  const thumbUrls = new Map();   // mapId -> objectURL | 'loading'
  let zt = d3.zoomIdentity;
  let fitted = false;
  let maps = [];

  // Anzeige je Karte (nur auf diesem Gerät): mode 'trans' | 'hidden', z = Reihenfolge
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem('ov-prefs') || '{}'); } catch { prefs = {}; }
  const savePrefs = () => localStorage.setItem('ov-prefs', JSON.stringify(prefs));
  const modeOf = (m) => prefs[m.id]?.mode || 'normal';
  const setMode = (id, mode) => { prefs[id] = { ...prefs[id], mode }; savePrefs(); render(); };
  let zTop = Math.max(0, ...Object.values(prefs).map((p) => p.z || 0));
  const toFront = (id) => { prefs[id] = { ...prefs[id], z: ++zTop, mode: prefs[id]?.mode === 'hidden' ? 'normal' : prefs[id]?.mode }; savePrefs(); render(); };
  // transparente zuerst, dann nach "Nach vorn"-Reihenfolge
  const drawOrder = (a, b) => (modeOf(a) === 'trans') - (modeOf(b) === 'trans') || (prefs[a.id]?.z || 0) - (prefs[b.id]?.z || 0);

  const scr = (ll) => zt.apply(toWorld(ll));
  const size = () => svg.node().getBoundingClientRect();
  const useTiles = () => localStorage.getItem('ov-tiles') !== '0';

  const zoom = d3.zoom()
    .scaleExtent([1, 2 ** 20])
    .on('zoom', (ev) => { zt = ev.transform; render(true); })
    .on('end', () => renderLines());   // Linien erst nach der Geste genau neu berechnen
  gRot.call(zoom).on('dblclick.zoom', null);
  const ofz = oneFingerZoom(svg, zoom, { zoomSel: gRot });
  twoFinger(svg.node(), gRot, zoom, { getR: rot, setR: (r) => setBearing(-r), onEnd: () => renderLines() });
  onBearing(() => { if (document.querySelector('#view-overview').classList.contains('active')) render(); });
  document.querySelector('#ov-north').onclick = () => animateBearing(0);

  // Tippen: kurz warten, ob ein zweiter Tipp (Doppeltipp-Zoom) folgt
  svg.on('click', (ev) => {
    if (ofz.busy()) return;
    const pt = d3.pointer(ev, gRot.node());   // lokale (ungedrehte) Koordinaten
    setTimeout(() => { if (!ofz.busy()) onTap(pt); }, ofz.DOUBLE_MS + 30);
  });

  function onTap([mx, my]) {
    const el = document.querySelector('#ov-info');
    if (el.innerHTML.trim()) { el.innerHTML = ''; return; }   // erster Tipp schließt nur das Fenster
    const ll = fromWorld(zt.invert([mx, my]));
    const poi = ctx.getPois().map((p) => {
      const [x, y] = scr(p.coords[0]);
      return { p, d: Math.hypot(x - mx, y - my) };
    }).filter((x) => x.d < 24).sort((a, b) => a.d - b.d)[0]?.p;
    if (poi) { showInfo([], poi.coords[0], poi); return; }
    const shown = maps.filter((m) => m.georef && modeOf(m) !== 'hidden');
    let hits = shown.filter((m) => inPolygon(ll, m.georef.footprint)).sort(drawOrder).reverse();
    if (!hits.length) {
      // weit herausgezoomt: nächstgelegenen Punkt nehmen
      hits = shown.map((m) => {
        const [x, y] = scr(centroid(m));
        return { m, d: Math.hypot(x - mx, y - my) };
      }).filter((x) => x.d < 26).sort((a, b) => a.d - b.d).map((x) => x.m).slice(0, 1);
    }
    showInfo(hits, ll, null);
  }

  function centroid(m) {
    const f = m.georef.footprint;
    return [d3.mean(f, (p) => p[0]), d3.mean(f, (p) => p[1])];
  }

  function showInfo(hits, ll, poi) {
    const el = document.querySelector('#ov-info');
    if (!ll) { el.innerHTML = ''; return; }
    pick = poi ? null : ll;
    renderPick();
    el.innerHTML = '<button class="ov-close" aria-label="Schließen">✕</button>' + ctx.pointPopupHTML(ll, poi) + hits.map((m) => `<div class="ov-card">
        <button class="ov-open" data-id="${m.id}"><b>${ctx.esc(m.name)}</b><span>${ctx.esc(m.revier || 'ohne Revier')} · ${ctx.statusLabel(m.status)}${m.hasPdf ? '' : ' · PDF fehlt'}</span></button>
        <div class="ov-acts">
          ${m.hasPdf ? `<button data-act="open" data-id="${m.id}" class="primary">Karte öffnen</button>` : ''}
          <button data-act="front" data-id="${m.id}">Nach vorn</button>
          <button data-act="trans" data-id="${m.id}">${modeOf(m) === 'trans' ? 'Deckend' : 'Transparent'}</button>
          <button data-act="hide" data-id="${m.id}">Ausblenden</button>
        </div></div>`).join('');
    ctx.bindPointPopup(el, ll, poi);
    requestAnimationFrame(() => keepVisible(ll, el));
    el.querySelectorAll('.ov-open').forEach((b) => (b.onclick = () => { el.innerHTML = ''; ctx.openMap(b.dataset.id); }));
    el.querySelector('.ov-close').onclick = () => { el.innerHTML = ''; };
    el.querySelectorAll('.ov-acts button').forEach((b) => (b.onclick = () => {
      const id = b.dataset.id, m = maps.find((x) => x.id === id);
      if (b.dataset.act === 'open') { el.innerHTML = ''; ctx.openMap(id); return; }
      if (b.dataset.act === 'front') toFront(id);
      if (b.dataset.act === 'trans') setMode(id, modeOf(m) === 'trans' ? 'normal' : 'trans');
      if (b.dataset.act === 'hide') { setMode(id, 'hidden'); ctx.toast(`„${m.name}“ ausgeblendet. Über ◫ Ebenen wieder einblenden.`); }
      showInfo(hits.filter((x) => modeOf(x) !== 'hidden'), ll, poi);
    }));
  }

  function fitAll(animate) {
    const pts = maps.filter((m) => m.georef).flatMap((m) => m.georef.footprint);
    if (!pts.length) {
      const p = ctx.getPos();
      if (p) centerOn([p.lat, p.lon], 2 ** 13, animate);
      return;
    }
    // Ausdehnung in gedrehter Lage bestimmen, Mitte zurückdrehen
    const w = pts.map(toWorld).map((p) => rotPt(p, rot()));
    const [x0, x1] = d3.extent(w, (p) => p[0]), [y0, y1] = d3.extent(w, (p) => p[1]);
    const mid = rotPt([(x0 + x1) / 2, (y0 + y1) / 2], -rot());
    const { width: W, height: H } = size();
    const k = Math.min(2 ** 17, 0.85 * Math.min(W / Math.max(x1 - x0, 1e-9), H / Math.max(y1 - y0, 1e-9)));
    const t = d3.zoomIdentity.translate(W / 2 - mid[0] * k, H / 2 - mid[1] * k).scale(k);
    (animate ? gRot.transition().duration(500) : gRot).call(zoom.transform, t);
  }

  function centerOn(ll, k, animate) {
    const [x, y] = toWorld(ll);
    const { width: W, height: H } = size();
    k = k ?? Math.max(zt.k, 2 ** 13);
    const t = d3.zoomIdentity.translate(W / 2 - x * k, H / 2 - y * k).scale(k);
    (animate ? gRot.transition().duration(500) : gRot).call(zoom.transform, t);
  }

  function renderTiles() {
    if (!useTiles()) { gTiles.selectAll('image').remove(); return; }
    const { width: W, height: H } = size();
    const z = Math.max(0, Math.min(19, Math.round(Math.log2(zt.k))));
    const n = 2 ** z, ts = TILE / n;
    // sichtbarer Bereich (gedreht) als Welt-Rechteck
    const cs = [[0, 0], [W, 0], [0, H], [W, H]].map((p) => zt.invert(toLocal(p)));
    const [wx0, wx1] = d3.extent(cs, (p) => p[0]), [wy0, wy1] = d3.extent(cs, (p) => p[1]);
    const tiles = [];
    for (let x = Math.floor(wx0 / ts); x <= Math.floor(wx1 / ts); x++) {
      for (let y = Math.max(0, Math.floor(wy0 / ts)); y <= Math.min(n - 1, Math.floor(wy1 / ts)); y++) {
        tiles.push({ x, y, z, key: `${z}/${x}/${y}` });
      }
    }
    const px = (TILE * zt.k) / n;
    gTiles.selectAll('image').data(tiles, (d) => d.key).join(
      (e) => e.append('image')
        .attr('href', (d) => `https://tile.openstreetmap.org/${d.z}/${((d.x % n) + n) % n}/${d.y}.png`)
        .on('error', function () { d3.select(this).remove(); })
    )
      .attr('x', (d) => zt.applyX(d.x * ts) - 0.25)
      .attr('y', (d) => zt.applyY(d.y * ts) - 0.25)
      .attr('width', px + 0.5).attr('height', px + 0.5);
  }

  function renderThumbs(visible) {
    const big = visible.filter((m) => m.hasPdf && screenSize(m) > 90);
    for (const m of big) {
      if (!thumbUrls.has(m.id)) {
        thumbUrls.set(m.id, 'loading');
        ctx.getThumb(m.id).then((b) => { if (b) { thumbUrls.set(m.id, URL.createObjectURL(b)); render(); } }).catch(() => {});
      }
    }
    const ready = big.filter((m) => thumbUrls.get(m.id) && thumbUrls.get(m.id) !== 'loading').sort(drawOrder);
    defs.selectAll('clipPath').data(ready, (m) => m.id).join((e) => e.append('clipPath').attr('id', (m) => `clip-${m.id}`).call((c) => c.append('path')))
      .select('path').attr('d', (m) => d3.line()(m.georef.footprint.map(scr)) + 'Z');
    gThumbs.selectAll('g.th').data(ready, (m) => m.id).join((e) => e.append('g').attr('class', 'th').call((g) => g.append('image')))
      .attr('clip-path', (m) => `url(#clip-${m.id})`)
      .attr('opacity', (m) => (modeOf(m) === 'trans' ? 0.18 : 1))
      .order()
      .select('image')
      .attr('href', (m) => thumbUrls.get(m.id))
      .attr('width', (m) => m.width).attr('height', (m) => m.height)
      .attr('preserveAspectRatio', 'none')
      .attr('transform', (m) => {
        // Bildpixel -> Bildschirm als affine Matrix (für kleine Ausschnitte exakt genug)
        const T = makeTransform(m.georef.coef);
        const P0 = scr(T.toLatLon(0, 0)), Pw = scr(T.toLatLon(m.width, 0)), Ph = scr(T.toLatLon(0, m.height));
        return `matrix(${(Pw[0] - P0[0]) / m.width},${(Pw[1] - P0[1]) / m.width},${(Ph[0] - P0[0]) / m.height},${(Ph[1] - P0[1]) / m.height},${P0[0]},${P0[1]})`;
      });
  }

  function screenSize(m) {
    const p = m.georef.footprint.map(scr);
    return Math.max(d3.max(p, (q) => q[0]) - d3.min(p, (q) => q[0]), d3.max(p, (q) => q[1]) - d3.min(p, (q) => q[1]));
  }

  function render(zooming = false) {
    const [cx, cy] = center();
    gRot.attr('transform', `rotate(${rot()},${cx},${cy})`);
    updateCompass(document.querySelector('#ov-north'));
    renderTiles();
    const visible = maps.filter((m) => m.georef && modeOf(m) !== 'hidden').sort(drawOrder);
    const nHidden = maps.filter((m) => m.georef && modeOf(m) === 'hidden').length;
    const hb = document.querySelector('#ov-hidden');
    hb.hidden = !nHidden;
    hb.textContent = `${nHidden} ausgeblendet`;
    const runningId = ctx.timerMapId();
    renderThumbs(visible);
    gFoot.selectAll('g.fp').data(visible, (m) => m.id).join((e) => {
      const g = e.append('g').attr('class', 'fp');
      g.append('path');
      g.append('circle');
      return g;
    }).order().each(function (m) {
      const g = d3.select(this), small = screenSize(m) < 14;
      const col = STATUS_COLOR[m.status] || '#64748b';
      const hasThumb = thumbUrls.get(m.id) && thumbUrls.get(m.id) !== 'loading' && screenSize(m) > 90;
      const trans = modeOf(m) === 'trans';
      g.select('path').attr('d', small ? null : d3.line()(m.georef.footprint.map(scr)) + 'Z')
        .attr('fill', col).attr('fill-opacity', trans ? 0 : hasThumb ? 0.06 : 0.22).attr('stroke-opacity', trans ? 0.5 : 1)
        .attr('stroke', m.id === runningId ? '#2563eb' : col).attr('stroke-width', m.id === runningId ? 4 : 2.5)
        .attr('stroke-dasharray', m.hasPdf ? null : '6 4');
      const [cx, cy] = scr(centroid(m));
      g.select('circle').attr('cx', cx).attr('cy', cy).attr('r', small ? 7 : 0)
        .attr('fill', col).attr('stroke', m.id === runningId ? '#2563eb' : '#fff').attr('stroke-width', 2);
    });
    gLabels.selectAll('text').data(visible.filter((m) => screenSize(m) > 70), (m) => m.id).join('text')
      .attr('class', 'ov-label').attr('opacity', (m) => (modeOf(m) === 'trans' ? 0.5 : 1))
      .attr('x', (m) => scr(centroid(m))[0]).attr('y', (m) => scr(centroid(m))[1])
      .attr('transform', (m) => { const [x, y] = scr(centroid(m)); return `rotate(${-rot()},${x},${y})`; })
      .text((m) => m.name);
    if (zooming) moveLines(); else renderLines();
    renderPois();
    renderPick();
    renderPos();
    document.querySelector('#ov-attr').hidden = !useTiles();
  }

  // ---- Linien & Tracks aus den Karten ----
  const LINE_K = 2 ** 12.5;     // ab hier sichtbar (Karten ca. 150 px breit)
  const LINE_COLOR = { erledigt: '#16a34a', offen: '#dc2626', hinweis: '#f59e0b' };
  const showLines = () => localStorage.getItem('ov-lines') !== '0';

  let linesT = null;   // Transformation beim letzten vollständigen Zeichnen

  /** Während des Zoomens: vorhandene Linien nur verschieben/skalieren (schnell) */
  function moveLines() {
    if (!linesT || !(showLines() && zt.k >= LINE_K)) { renderLines(); return; }
    const r = zt.k / linesT.k;
    if (r > 4 || r < 0.25) { renderLines(); return; }   // zu weit weg: lieber neu
    gLines.attr('transform', `translate(${zt.x - linesT.x * r},${zt.y - linesT.y * r}) scale(${r})`);
  }

  function renderLines() {
    gLines.attr('transform', null);
    linesT = zt;
    const visibleNow = showLines() && zt.k >= LINE_K;
    if (!visibleNow) { gLines.selectAll('*').remove(); return; }
    const { width: W, height: H } = size();
    const mode = Object.fromEntries(maps.map((m) => [m.id, modeOf(m)]));
    const out = [];
    for (const f of ctx.getLines()) {
      const md = mode[f.mapId];
      if (md === undefined || md === 'hidden') continue;   // Karte nicht im Filter (z. B. andere Saison) oder ausgeblendet
      // Grob-Test über die Bounding-Box, ob im Bild
      if (f.bbox) {
        const [x0, y1] = scr([f.bbox[0], f.bbox[1]]), [x1, y0] = scr([f.bbox[2], f.bbox[3]]);
        if (x1 < -20 || x0 > W + 20 || y1 < -20 || y0 > H + 20) continue;
      }
      // Punkte, die auf dem Bildschirm zusammenfallen, weglassen
      const pts = [];
      let last = null;
      for (const c of f.coords) {
        const p = scr(c);
        if (!last || Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) > 1.5) { pts.push(p); last = p; }
      }
      const lp = scr(f.coords[f.coords.length - 1]);
      if (pts.length && (pts[pts.length - 1][0] !== lp[0] || pts[pts.length - 1][1] !== lp[1])) pts.push(lp);
      if (pts.length > 1) out.push({ f, pts, trans: md === 'trans' });
    }
    const line = d3.line();
    gLines.selectAll('path').data(out, (d) => d.f.id).join('path')
      .attr('d', (d) => line(d.pts))
      .attr('fill', 'none')
      .attr('stroke', (d) => LINE_COLOR[d.f.kind] || '#555')
      .attr('stroke-width', (d) => (d.f.type === 'track' ? 4 : 3.5))
      .attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round')
      .attr('vector-effect', 'non-scaling-stroke')
      .attr('stroke-dasharray', (d) => (d.f.kind === 'hinweis' ? '8 6' : null))
      .attr('opacity', (d) => (d.trans ? 0.35 : 0.95));
  }

  function renderPois() {
    const g = gPoi.selectAll('g.poi').data(ctx.getPois(), (p) => p.id).join((e) => {
      const ge = e.append('g').attr('class', 'poi');
      ge.append('circle').attr('r', 15);
      ge.append('text').attr('class', 'poi-icon').attr('dy', '0.35em');
      ge.append('text').attr('class', 'poi-label').attr('y', 28);
      return ge;
    });
    g.attr('transform', (p) => `translate(${scr(p.coords[0])}) rotate(${-rot()})`);
    g.select('.poi-icon').text((p) => ctx.poiIcon(p));
    g.select('.poi-label').text((p) => (zt.k > 2 ** 13 ? p.name || '' : ''));
  }

  /** Karte so verschieben, dass der Punkt sichtbar über dem Fenster liegt */
  function keepVisible(ll, el) {
    const sr = svg.node().getBoundingClientRect(), pr = el.getBoundingClientRect();
    const free = pr.top - sr.top;                 // sichtbare Höhe über dem Fenster
    const [x, y] = toScreen(scr(ll));
    const dy = y > free - 45 || y < 45 ? free / 2 - y : 0;
    const dx = x < 30 || x > sr.width - 30 ? sr.width / 2 - x : 0;
    if (dx || dy) {
      const [lx, ly] = rotPt([dx, dy], -rot());
      gRot.transition().duration(300).call(zoom.translateBy, lx / zt.k, ly / zt.k);
    }
  }

  function renderPick() {
    gPick.selectAll('*').remove();
    if (!pick) return;
    const [x, y] = scr(pick);
    ctx.drawPin(gPick.append('g').attr('transform', `rotate(${-rot()},${x},${y})`), x, y);
  }
  // Fenster zu -> Stecknadel weg
  new MutationObserver(() => {
    const open = !!document.querySelector('#ov-info').innerHTML.trim();
    document.body.classList.toggle('ov-popup', open);
    if (!open && pick) { pick = null; renderPick(); }
  }).observe(document.querySelector('#ov-info'), { childList: true });

  function renderPos() {
    gPos.selectAll('*').remove();
    const p = ctx.getPos();
    if (!p) return;
    const [x, y] = scr([p.lat, p.lon]);
    gPos.append('circle').attr('cx', x).attr('cy', y).attr('r', 9).attr('fill', '#2563eb').attr('stroke', '#fff').attr('stroke-width', 3);
  }

  document.querySelector('#ov-fit').onclick = () => fitAll(true);
  document.querySelector('#ov-pos').onclick = () => {
    const p = ctx.getPos();
    if (!p) { ctx.toast('Noch keine GPS-Position.'); return; }
    centerOn([p.lat, p.lon], Math.max(zt.k, 2 ** 14), true);
  };
  document.querySelector('#ov-tiles').onclick = () => {
    localStorage.setItem('ov-tiles', useTiles() ? '0' : '1');
    render();
    ctx.toast(useTiles() ? 'Hintergrundkarte an (nur mit Internet)' : 'Hintergrundkarte aus');
  };
  // Ebenen-Dialog
  const openLayers = () => {
    const list = maps.filter((m) => m.georef).sort((a, b) => (a.revier || '').localeCompare(b.revier || '', 'de') || a.name.localeCompare(b.name, 'de'));
    document.querySelector('#layers-list').innerHTML = list.map((m) => `<li>
        <span><b>${ctx.esc(m.name)}</b><small>${ctx.esc(m.revier || 'ohne Revier')}</small></span>
        <select data-id="${m.id}">
          <option value="normal" ${modeOf(m) === 'normal' ? 'selected' : ''}>Sichtbar</option>
          <option value="trans" ${modeOf(m) === 'trans' ? 'selected' : ''}>Transparent</option>
          <option value="hidden" ${modeOf(m) === 'hidden' ? 'selected' : ''}>Aus</option>
        </select></li>`).join('') || '<li class="muted">Keine Karten im aktuellen Filter.</li>';
    document.querySelectorAll('#layers-list select').forEach((s) => (s.onchange = () => setMode(s.dataset.id, s.value)));
    const cb = document.querySelector('#layers-lines');
    cb.checked = showLines();
    cb.onchange = () => { localStorage.setItem('ov-lines', cb.checked ? '1' : '0'); render(); };
    document.querySelector('#dlg-layers').showModal();
  };
  document.querySelector('#ov-layers').onclick = openLayers;
  document.querySelector('#ov-hidden').onclick = openLayers;
  document.querySelector('#layers-reset').onclick = () => {
    for (const m of maps) delete prefs[m.id];
    savePrefs(); render(); openLayers();
  };

  window.addEventListener('resize', () => document.querySelector('#view-overview').classList.contains('active') && render());

  return {
    show(list) {
      maps = list;
      document.querySelector('#ov-info').innerHTML = '';
      if (!fitted) { fitAll(false); fitted = true; } else render();
    },
    update(list) { if (list) maps = list; render(); },
    updatePos: renderPos,
    fitAll,
    addPoiHere: () => ctx.addPoiAtPos(),
  };
}
