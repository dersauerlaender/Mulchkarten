// Mulchkarten – Oberfläche
import { db } from './db.js';
import * as M from './model.js';
import { makeTransform, inPolygon, distToPolygon, distMeters, bboxOverlap } from './georef.js';
import { initOverview } from './overview.js';

export const APP_VERSION = '1.2.1';
const d3 = window.d3;
const $ = (s) => document.querySelector(s);
const KINDS = ['erledigt', 'offen', 'hinweis'];
const KIND_LABEL = { erledigt: 'Erledigt', offen: 'Offen', hinweis: 'Hinweis' };
const STATUS_LABEL = { offen: 'Offen', arbeit: 'In Arbeit', fertig: 'Fertig' };

// ---------- Zustand ----------
const S = {
  maps: [],
  pos: null,               // {lat, lon, acc, heading, speed, t}
  map: null,               // aktuell geöffnete Karte
  T: null,                 // Transformation Pixel <-> lat/lon
  mPerPx: 1,
  zoom: null,
  zt: d3.zoomIdentity,
  follow: false,
  draw: false,
  kind: 'erledigt',
  stroke: null,            // laufende Freihandlinie
  rec: null,               // laufende Track-Aufnahme
  wakeLock: null,
  selected: null,
  undo: [],
  features: [],
  listTimer: 0,
  timer: null,             // laufender Zeiteintrag
  cand: null,              // Kandidat für Zählstellen-Wechsel {mapId, since, n}
  declined: new Map(),     // mapId -> bis wann nicht mehr fragen
  dwellMs: 15000,          // so lange muss man auf der neuen Karte sein, bevor gefragt wird
  returnView: 'view-list',
};
const FAR_M = 3000;        // ab dieser Entfernung springt "Position" nicht mehr

// ---------- Hilfen ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtDist(m) {
  if (m == null) return '';
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}
function fmtHours(h) {
  const t = Math.round(h * 60);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} h`;
}
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '');
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '');

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busy-text').textContent = text;
}
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
}

// ---------- Start ----------
async function init() {
  $('#app-version').textContent = APP_VERSION;
  await M.settings.load();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.().catch(() => {});

  bindList();
  bindMap();
  bindDialogs();
  bindTimer();
  ov = initOverview({
    esc, toast, openMap, getThumb: M.getThumb,
    getPos: () => S.pos,
    statusLabel: (s) => STATUS_LABEL[s] || s,
    timerMapId: () => S.timer?.mapId,
  });

  await recoverRecording();
  await refreshMaps();
  await loadTimer();
  startGps();
  await processShareInbox();
  if (!M.settings.user) openSettings(true);
}

let ov;
async function refreshMaps() {
  S.maps = await M.getMaps();
  fillFilters();
  renderList();
  if ($('#view-overview').classList.contains('active')) ov.update(filteredMaps());
}

// ---------- GPS ----------
function startGps() {
  if (!('geolocation' in navigator)) { $('#gps-line').textContent = 'Kein GPS verfügbar.'; return; }
  navigator.geolocation.watchPosition(onPos, (err) => {
    $('#gps-line').textContent = err.code === 1 ? 'GPS nicht erlaubt – bitte in den Browser-Einstellungen freigeben.' : 'GPS: kein Signal';
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}

function onPos(p) {
  const c = p.coords;
  S.pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, heading: c.heading, speed: c.speed, t: p.timestamp };
  $('#gps-line').textContent = `GPS ±${Math.round(c.accuracy)} m · ${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`;
  if (S.rec) addRecPoint();
  checkZone();
  if ($('#view-overview').classList.contains('active')) ov.updatePos();
  if ($('#view-list').classList.contains('active')) {
    if (!S.listTimer) S.listTimer = setTimeout(() => { S.listTimer = 0; renderList(); }, 1500);
  } else if (S.map) {
    if (S.follow && !isFar()) centerOnPos(false);
    drawPos();
    updateInfo();
  }
}

// ---------- Liste ----------
function fillFilters() {
  const seasons = [...new Set([M.settings.season, ...S.maps.map((m) => m.season).filter(Boolean)])].sort().reverse();
  const reviere = [...new Set(S.maps.map((m) => m.revier).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const fs = $('#f-season'), fr = $('#f-revier');
  const curS = fs.value || localStorage.getItem('f-season') || M.settings.season;
  const curR = fr.value || localStorage.getItem('f-revier') || '';
  fs.innerHTML = `<option value="alle">Alle Saisons</option>` + seasons.map((s) => `<option value="${esc(s)}">Saison ${esc(s)}</option>`).join('');
  fr.innerHTML = `<option value="">Alle Reviere</option><option value="-">(ohne Revier)</option>` + reviere.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
  fs.value = [...fs.options].some((o) => o.value === curS) ? curS : M.settings.season;
  fr.value = [...fr.options].some((o) => o.value === curR) ? curR : '';
  $('#dl-seasons').innerHTML = seasons.map((s) => `<option value="${esc(s)}">`).join('');
  $('#dl-reviere').innerHTML = reviere.map((r) => `<option value="${esc(r)}">`).join('');
}

function mapDistance(m) {
  if (!S.pos || !m.georef) return null;
  return distToPolygon([S.pos.lat, S.pos.lon], m.georef.footprint);
}

function filteredMaps() {
  const fs = $('#f-season').value, fr = $('#f-revier').value, hide = $('#f-hidedone').checked;
  return S.maps.filter((m) =>
    (fs === 'alle' || m.season === fs) &&
    (!fr || (fr === '-' ? !m.revier : m.revier === fr)) &&
    (!hide || m.status !== 'fertig'));
}

function renderList() {
  const fs = $('#f-season').value, fr = $('#f-revier').value, hide = $('#f-hidedone').checked;
  localStorage.setItem('f-season', fs);
  localStorage.setItem('f-revier', fr);
  localStorage.setItem('f-hidedone', hide ? '1' : '');
  let list = filteredMaps();
  list = list.map((m) => ({ m, d: mapDistance(m) }));
  list.sort((a, b) => {
    if (a.d != null && b.d != null && a.d !== b.d) return a.d - b.d;
    if ((a.d == null) !== (b.d == null)) return a.d == null ? 1 : -1;
    return (a.m.revier || '').localeCompare(b.m.revier || '', 'de') || a.m.name.localeCompare(b.m.name, 'de');
  });
  $('#empty').hidden = S.maps.length > 0;
  const hereCount = list.filter((x) => x.d === 0).length;
  let html = '';
  if (S.pos && list.length) html += `<li class="group-h">${hereCount ? `Du bist auf ${hereCount === 1 ? 'dieser Karte' : `${hereCount} Karten`}` : 'Nach Entfernung sortiert'}</li>`;
  html += list.map(({ m, d }) => `
    <li class="map-card ${d === 0 ? 'here' : ''} ${m.status === 'fertig' ? 'done' : ''}" data-id="${m.id}">
      <div class="name">${esc(m.name)}</div>
      <div class="dist">${d === 0 ? '📍 Hier' : esc(fmtDist(d))}</div>
      <div class="sub">${S.timer?.mapId === m.id ? '<span class="chip" style="background:#1e3a8a">⏱ läuft</span>' : ''}
        <span class="chip ${m.status}">${STATUS_LABEL[m.status] || m.status}</span>${m.hasPdf ? '' : '<span class="chip nopdf">PDF fehlt</span>'}
        ${esc(m.revier || 'ohne Revier')} · ${esc(m.season || '–')}${m.status === 'fertig' && m.doneBy ? ` · fertig ${fmtDate(m.doneAt)} ${esc(m.doneBy)}` : ''}
      </div>
    </li>`).join('');
  if (S.maps.length && !list.length) html += `<li class="empty">Keine Karten für diesen Filter.</li>`;
  $('#map-list').innerHTML = html;
}

function bindList() {
  $('#f-hidedone').checked = !!localStorage.getItem('f-hidedone');
  ['#f-season', '#f-revier', '#f-hidedone'].forEach((s) => $(s).addEventListener('change', renderList));
  $('#map-list').addEventListener('click', (e) => {
    const li = e.target.closest('.map-card');
    if (!li) return;
    const m = S.maps.find((x) => x.id === li.dataset.id);
    if (!m.hasPdf) { toast('Für diese Karte fehlt noch die PDF.\nBitte die PDF aus WhatsApp importieren – Linien und Status werden dann automatisch zugeordnet.', 6000); return; }
    openMap(m.id);
  });
  $('#btn-ov').onclick = () => { showView('view-overview'); ov.show(filteredMaps()); };
  $('#ov-back').onclick = () => { showView('view-list'); renderList(); };
  $('#file-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await handleFiles(files);
  });
}

// ---------- Import ----------
async function handleFiles(files) {
  if (!files.length) return;
  const isPdf = (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
  const pdfs = files.filter(isPdf), others = files.filter((f) => !isPdf(f));
  const msgs = [];
  let n = 0;
  for (const f of pdfs) {
    busy(`Karte ${++n}/${pdfs.length} wird eingelesen …\n${f.name}`);
    try {
      const r = await M.importPdfFile(f);
      msgs.push(r.result === 'doppelt' ? `„${r.map.name}“ war schon vorhanden` : r.result === 'ergänzt' ? `PDF für „${r.map.name}“ ergänzt` : `Neu: „${r.map.name}“`);
    } catch (err) {
      console.error(err);
      msgs.push(`✗ ${f.name}: ${err.message}`);
    }
  }
  for (const f of others) {
    busy('Arbeitsstand wird übernommen …');
    try {
      const data = parseState(await f.text());
      const s = await M.mergeState(data);
      msgs.push(`Stand von ${data.exportedBy || '?'} (${fmtDate(data.exportedAt)} ${fmtTime(data.exportedAt)}) übernommen:` +
        ` ${s.mapsNew + s.mapsUpd} Karten aktualisiert, ${s.featNew} Linien neu, ${s.featUpd} geändert, ${s.featDel} gelöscht, ${s.timesNew} Zeiteinträge neu` +
        (s.missingPdf ? `\n${s.missingPdf} Karte(n) ohne PDF – bitte PDF nachladen.` : ''));
    } catch (err) {
      console.error(err);
      msgs.push(`✗ ${f.name}: ${err instanceof SyntaxError ? 'keine gültige Mulchkarten-Datei' : err.message}`);
    }
  }
  busy(false);
  await refreshMaps();
  if (S.map) await reloadFeatures();
  toast(msgs.join('\n'), 7000);
}

/** Stand-Text lesen; tolerant gegenüber BOM und Text drumherum (z. B. aus Messenger kopiert). */
function parseState(text) {
  text = text.replace(/^\ufeff/, '').trim();
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new SyntaxError('kein JSON');
  return JSON.parse(text.slice(a, b + 1));
}

async function importStateText(text, label) {
  busy('Arbeitsstand wird übernommen …');
  try {
    const data = parseState(text);
    const s = await M.mergeState(data);
    toast(`Stand von ${data.exportedBy || '?'} übernommen: ${s.mapsNew + s.mapsUpd} Karten aktualisiert, ${s.featNew} Linien neu, ${s.timesNew} Zeiteinträge neu` +
      (s.missingPdf ? `\n${s.missingPdf} Karte(n) ohne PDF – bitte PDFs nachladen.` : ''), 7000);
  } catch (err) {
    toast(`✗ ${label}: ${err instanceof SyntaxError ? 'kein gültiger Mulchkarten-Stand' : err.message}`, 6000);
  }
  busy(false);
  await refreshMaps();
}

async function processShareInbox() {
  if (!('caches' in window)) return;
  const cache = await caches.open('share-inbox');
  const reqs = await cache.keys();
  if (!reqs.length) return;
  const files = [];
  for (const r of reqs) {
    const res = await cache.match(r);
    const name = decodeURIComponent(res.headers.get('X-Filename') || 'datei');
    files.push(new File([await res.blob()], name, { type: res.headers.get('Content-Type') || '' }));
    await cache.delete(r);
  }
  history.replaceState(null, '', location.pathname);
  await handleFiles(files);
}

// ---------- Kartenansicht ----------
let svg, gZoom, gImg, gFeat, gLive, gPos;

function bindMap() {
  svg = d3.select('#svg');
  gZoom = svg.append('g');
  gImg = gZoom.append('g');
  gFeat = gZoom.append('g');
  gLive = gZoom.append('g');
  gPos = svg.append('g').attr('pointer-events', 'none');

  S.zoom = d3.zoom()
    .filter((ev) => {
      if (S.draw) return ev.type === 'wheel' || (ev.touches && ev.touches.length >= 2);
      return (!ev.ctrlKey || ev.type === 'wheel') && !ev.button;
    })
    .on('zoom', (ev) => {
      S.zt = ev.transform;
      gZoom.attr('transform', ev.transform);
      if (ev.sourceEvent && S.follow) setFollow(false);
      drawPos();
    });
  svg.call(S.zoom);

  // Freihand zeichnen
  const node = svg.node();
  const pointers = new Set();
  node.addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId);
    if (!S.draw) return;
    if (pointers.size > 1) { cancelStroke(); return; }
    node.setPointerCapture(e.pointerId);
    S.stroke = { id: e.pointerId, pts: [toLatLon(e)], last: [e.clientX, e.clientY] };
    renderLive();
  });
  node.addEventListener('pointermove', (e) => {
    if (!S.stroke || e.pointerId !== S.stroke.id) return;
    if (Math.hypot(e.clientX - S.stroke.last[0], e.clientY - S.stroke.last[1]) < 4) return;
    S.stroke.last = [e.clientX, e.clientY];
    S.stroke.pts.push(toLatLon(e));
    renderLive();
  });
  const end = async (e) => {
    pointers.delete(e.pointerId);
    if (!S.stroke || e.pointerId !== S.stroke.id) return;
    const pts = S.stroke.pts;
    S.stroke = null;
    renderLive();
    if (pts.length >= 2) {
      const f = await M.saveFeature(M.newFeature({ type: 'draw', kind: S.kind, mapId: S.map.id, coords: pts }));
      S.undo.push(f.id);
      await reloadFeatures();
    }
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); cancelStroke(); });

  // Auswahl
  svg.on('click', (ev) => {
    if (S.draw) return;
    const hit = ev.target.closest?.('.hit');
    select(hit ? hit.dataset.id : null);
  });

  $('#btn-back').onclick = closeMap;
  $('#t-follow').onclick = () => {
    if (isFar()) {
      const d = distToPolygon([S.pos.lat, S.pos.lon], S.map.georef.footprint);
      toast(`Du bist ${fmtDist(d)} von dieser Karte entfernt.`);
      fitMap(true);
      return;
    }
    setFollow(true);
    centerOnPos(true);
  };
  $('#t-fit').onclick = () => { setFollow(false); fitMap(true); };
  $('#t-time').onclick = timeToolClick;
  $('#t-draw').onclick = () => setDraw(!S.draw);
  $('#t-kind').onclick = () => setKind(KINDS[(KINDS.indexOf(S.kind) + 1) % KINDS.length]);
  $('#t-rec').onclick = () => (S.rec ? stopRec() : startRec());
  $('#t-undo').onclick = undo;
  $('#map-status').onchange = async (e) => {
    S.map = await M.updateMap(S.map.id, { status: e.target.value });
    toast(`Status: ${STATUS_LABEL[S.map.status]}`);
  };
  $('#btn-edit').onclick = openEdit;
  document.querySelectorAll('#sel-bar .kind').forEach((b) => (b.onclick = async () => {
    const f = S.features.find((x) => x.id === S.selected);
    if (!f) return;
    f.kind = b.dataset.kind;
    await M.saveFeature(f);
    await reloadFeatures();
  }));
  $('#sel-del').onclick = async () => {
    if (!S.selected) return;
    await M.deleteFeature(S.selected);
    select(null);
    await reloadFeatures();
  };
  $('#sel-close').onclick = () => select(null);
  window.addEventListener('resize', () => S.map && drawPos());
}

function cancelStroke() { S.stroke = null; renderLive(); }

function toLatLon(e) {
  const r = svg.node().getBoundingClientRect();
  const [u, v] = S.zt.invert([e.clientX - r.left, e.clientY - r.top]);
  return S.T.toLatLon(u, v).map((x) => +x.toFixed(7));
}
const toPx = ([lat, lon]) => S.T.toPixel(lat, lon);

async function openMap(id) {
  const m = await M.getMap(id);
  const blob = await M.getImage(id);
  if (!blob) { toast('Kartenbild fehlt – bitte PDF erneut importieren.'); return; }
  const cur = document.querySelector('.view.active')?.id;
  if (cur && cur !== 'view-map') S.returnView = cur;
  S.map = m;
  S.T = makeTransform(m.georef.coef);
  S.mPerPx = distMeters(S.T.toLatLon(0, 0), S.T.toLatLon(100, 0)) / 100;
  S.undo = [];
  select(null);
  setDraw(false);
  $('#map-title').textContent = m.name;
  $('#map-status').value = m.status;
  showView('view-map');

  const url = URL.createObjectURL(blob);
  gImg.selectAll('*').remove();
  gImg.append('image').attr('href', url).attr('width', m.width).attr('height', m.height);
  gImg.append('path').attr('class', 'footprint')
    .attr('d', d3.line()(m.georef.footprint.map(toPx)) + 'Z');
  if (S.imgUrl) URL.revokeObjectURL(S.imgUrl);
  S.imgUrl = url;

  const { width: W } = $('#stage').getBoundingClientRect();
  const k0 = fitMap(false);
  renderTimerBar();

  await reloadFeatures();
  const here = S.pos && inPolygon([S.pos.lat, S.pos.lon], m.georef.footprint);
  setFollow(!!here);
  // Start-Zoom: etwa 800 m Bildschirmbreite sichtbar
  if (here) centerOnPos(false, Math.max(k0, (W * S.mPerPx) / 800));
  drawPos();
  updateInfo();
}

function closeMap() {
  if (S.rec && !confirm('Track-Aufnahme läuft. Beenden und speichern?')) return;
  if (S.rec) stopRec();
  S.map = null;
  setDraw(false);
  showView(S.returnView || 'view-list');
  refreshMaps();
}

/** Ganze Karte einpassen. Liefert den Einpass-Zoom. */
function fitMap(animate) {
  const m = S.map;
  const { width: W, height: H } = $('#stage').getBoundingClientRect();
  const k0 = Math.min(W / m.width, H / m.height);
  S.zoom.scaleExtent([k0 * 0.5, 4]).translateExtent([[-m.width * 0.5, -m.height * 0.5], [m.width * 1.5, m.height * 1.5]]);
  const t = d3.zoomIdentity.translate((W - m.width * k0) / 2, (H - m.height * k0) / 2).scale(k0);
  (animate ? svg.transition().duration(400) : svg).call(S.zoom.transform, t);
  return k0;
}

function isFar() {
  return !!(S.pos && S.map && distToPolygon([S.pos.lat, S.pos.lon], S.map.georef.footprint) > FAR_M);
}

async function reloadFeatures() {
  if (!S.map) return;
  const bb = S.map.georef.bbox;
  S.features = (await M.getFeatures()).filter((f) => f.bbox && bboxOverlap(f.bbox, bb));
  renderFeatures();
}

function renderFeatures() {
  const line = d3.line();
  const data = S.features.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const g = gFeat.selectAll('g.f').data(data, (d) => d.id).join((enter) => {
    const ge = enter.append('g').attr('class', 'f');
    ge.append('path').attr('class', 'vis');
    ge.append('path').attr('class', 'hit');
    return ge;
  });
  g.select('.vis').attr('class', (d) => `vis feat ${d.kind} ${d.type} ${d.id === S.selected ? 'sel' : ''}`)
    .attr('d', (d) => line(d.coords.map(toPx)));
  g.select('.hit').attr('data-id', (d) => d.id).attr('d', (d) => line(d.coords.map(toPx)));
}

function renderLive() {
  const lines = [];
  if (S.stroke) lines.push({ k: S.kind, c: S.stroke.pts });
  if (S.rec && S.rec.mapId === S.map?.id) lines.push({ k: S.rec.kind, c: S.rec.coords });
  gLive.selectAll('path').data(lines).join('path')
    .attr('class', 'live')
    .attr('stroke', (d) => getComputedStyle(document.documentElement).getPropertyValue(`--c-${d.k}`))
    .attr('d', (d) => d3.line()(d.c.map(toPx)));
}

function select(id) {
  S.selected = id;
  const f = S.features.find((x) => x.id === id);
  $('#sel-bar').hidden = !f;
  if (f) {
    const parts = [f.type === 'track' ? 'GPS-Track' : 'Gezeichnet', `von ${f.author || '?'}`, `${fmtDate(f.createdAt)} ${fmtTime(f.createdAt)}`, fmtDist(f.length)];
    if (f.type === 'track') parts.push(`${fmtTime(f.startedAt)}–${fmtTime(f.endedAt)} (${fmtHours(M.trackHours(f))})`);
    $('#sel-info').textContent = parts.join(' · ');
  }
  renderFeatures();
}

// Position
function drawPos() {
  gPos.selectAll('*').remove();
  if (!S.pos || !S.map) return;
  const [u, v] = toPx([S.pos.lat, S.pos.lon]);
  const [x, y] = S.zt.apply([u, v]);
  const r = (S.pos.acc / S.mPerPx) * S.zt.k;
  gPos.append('circle').attr('cx', x).attr('cy', y).attr('r', Math.max(r, 10)).attr('fill', '#2563eb22').attr('stroke', '#2563eb66');
  if (S.pos.heading != null && !isNaN(S.pos.heading) && (S.pos.speed ?? 0) > 0.5) {
    gPos.append('path').attr('d', 'M0,-26 L9,-8 L-9,-8 Z').attr('fill', '#2563eb')
      .attr('transform', `translate(${x},${y}) rotate(${S.pos.heading})`);
  }
  gPos.append('circle').attr('cx', x).attr('cy', y).attr('r', 9).attr('fill', '#2563eb').attr('stroke', '#fff').attr('stroke-width', 3);
}

function centerOnPos(animate, k) {
  if (!S.pos || !S.map) { toast('Noch keine GPS-Position.'); return; }
  const [u, v] = toPx([S.pos.lat, S.pos.lon]);
  const { width: W, height: H } = $('#stage').getBoundingClientRect();
  const kk = k ?? Math.max(S.zt.k, 0.8);
  const t = d3.zoomIdentity.translate(W / 2 - u * kk, H / 2 - v * kk).scale(kk);
  (animate ? svg.transition().duration(400) : svg).call(S.zoom.transform, t);
}

function setFollow(on) {
  S.follow = on;
  $('#t-follow').classList.toggle('on', on);
}

function updateInfo() {
  const el = $('#map-info');
  if (!S.map) return;
  if (!S.pos) { el.textContent = 'Warte auf GPS …'; return; }
  const p = [S.pos.lat, S.pos.lon];
  const d = distToPolygon(p, S.map.georef.footprint);
  if (d === 0) { el.textContent = `📍 Du bist auf dieser Karte · ±${Math.round(S.pos.acc)} m`; return; }
  const other = S.maps.find((m) => m.id !== S.map.id && m.hasPdf && m.georef && inPolygon(p, m.georef.footprint));
  el.innerHTML = `${esc(fmtDist(d))} außerhalb dieser Karte` + (other ? ` <button data-open="${other.id}">→ ${esc(other.name)}</button>` : '');
  const b = el.querySelector('button');
  if (b) b.onclick = () => openMap(b.dataset.open);
}

// Werkzeuge
function setDraw(on) {
  S.draw = on;
  $('#t-draw').classList.toggle('on', on);
  $('#stage').classList.toggle('drawing', on);
  if (on) select(null);
}
function setKind(k) {
  S.kind = k;
  const b = $('#t-kind');
  b.className = `tool kindtool k-${k}`;
  $('#t-kind-lbl').textContent = KIND_LABEL[k];
  if (S.rec) { S.rec.kind = k; renderLive(); }
}
async function undo() {
  const id = S.undo.pop();
  if (!id) { toast('Nichts zum Rückgängigmachen.'); return; }
  await M.deleteFeature(id);
  await reloadFeatures();
}

// Track-Aufnahme
async function startRec() {
  if (!S.pos) { toast('Noch kein GPS-Signal.'); return; }
  S.rec = { mapId: S.map.id, kind: S.kind, coords: [], startedAt: M.now() };
  addRecPoint();
  $('#t-rec').classList.add('on');
  $('#rec-badge').hidden = false;
  setFollow(true);
  try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* nicht unterstützt */ }
  toast('Track-Aufnahme läuft. Bildschirm bleibt an – App bitte im Vordergrund lassen.', 5000);
}

function addRecPoint() {
  const p = S.pos, r = S.rec;
  if (!p || p.acc > 30) return;
  const pt = [+p.lat.toFixed(7), +p.lon.toFixed(7)];
  const last = r.coords[r.coords.length - 1];
  if (last && distMeters(last, pt) < 4) return;
  r.coords.push(pt);
  r.lastAt = M.now();
  db.meta.set('rec', r);
  const len = r.coords.reduce((s, c, i) => (i ? s + distMeters(r.coords[i - 1], c) : 0), 0);
  $('#rec-stats').textContent = `${fmtDist(len)} · ${fmtHours((Date.now() - new Date(r.startedAt)) / 3.6e6)}`;
  renderLive();
}

async function stopRec() {
  const r = S.rec;
  S.rec = null;
  $('#t-rec').classList.remove('on');
  $('#rec-badge').hidden = true;
  try { await S.wakeLock?.release(); } catch { /* egal */ }
  S.wakeLock = null;
  await db.meta.set('rec', null);
  renderLive();
  if (r.coords.length < 2) { toast('Track zu kurz – nicht gespeichert.'); return; }
  const f = await M.saveFeature(M.newFeature({ type: 'track', kind: r.kind, mapId: r.mapId, coords: r.coords, startedAt: r.startedAt, endedAt: M.now() }));
  S.undo.push(f.id);
  const m = await M.getMap(r.mapId);
  if (m?.status === 'offen') {
    const up = await M.updateMap(r.mapId, { status: 'arbeit' });
    if (S.map?.id === up.id) { S.map = up; $('#map-status').value = 'arbeit'; }
  }
  await reloadFeatures();
  toast(`Track gespeichert (${fmtDist(f.length)}).`);
}

async function recoverRecording() {
  const r = await db.meta.get('rec', null);
  if (!r) return;
  await db.meta.set('rec', null);
  if (r.coords?.length >= 2) {
    await M.saveFeature(M.newFeature({ type: 'track', kind: r.kind, mapId: r.mapId, coords: r.coords, startedAt: r.startedAt, endedAt: r.lastAt || M.now() }));
    toast('Ein unterbrochener Track wurde gespeichert.');
  }
}

// ---------- Dialoge ----------
function bindDialogs() {
  // Bearbeiten
  $('#dlg-edit').addEventListener('close', async () => {
    const dlg = $('#dlg-edit'), f = dlg.querySelector('form');
    if (dlg.returnValue === 'ok') {
      S.map = await M.updateMap(S.map.id, {
        name: f.name.value.trim() || S.map.name,
        season: f.season.value.trim(),
        revier: f.revier.value.trim(),
        note: f.note.value.trim(),
      });
      $('#map-title').textContent = S.map.name;
      S.maps = await M.getMaps();
    } else if (dlg.returnValue === 'delete') {
      if (confirm(`Karte „${S.map.name}“ von diesem Gerät entfernen? Linien und Tracks bleiben erhalten.`)) {
        await M.deleteMapLocal(S.map.id);
        S.map = null;
        showView('view-list');
        await refreshMaps();
      }
    }
  });

  // Stand als Text einfügen
  $('#btn-paste').onclick = () => {
    $('#dlg-settings').close('cancel');
    const f = $('#dlg-paste form');
    f.txt.value = '';
    $('#dlg-paste').showModal();
  };
  $('#dlg-paste').addEventListener('close', () => {
    const v = $('#dlg-paste form').txt.value;
    if ($('#dlg-paste').returnValue === 'ok' && v.trim()) importStateText(v, 'Eingefügter Text');
  });

  // Teilen
  $('#btn-share').onclick = openShare;
  $('#dlg-noshare').addEventListener('close', () => {
    if ($('#dlg-noshare').returnValue === 'download' && pendingDownload) downloadFiles(pendingDownload);
    pendingDownload = null;
  });
  const sf = $('#dlg-share form');
  sf.season.onchange = prepareShare;
  sf.withPdf.onchange = prepareShare;
  sf.querySelector('button[value=ok]').addEventListener('click', (e) => {
    e.preventDefault();
    doShare();
  });

  // Einstellungen
  $('#btn-settings').onclick = () => openSettings(false);
  $('#dlg-settings').addEventListener('close', async () => {
    const dlg = $('#dlg-settings'), f = dlg.querySelector('form');
    if (dlg.returnValue === 'wipe') {
      if (confirm('Wirklich ALLE Karten, Linien und Tracks auf diesem Gerät löschen?')) {
        for (const s of ['maps', 'blobs', 'features', 'times']) await db.clear(s);
        S.timer = null; renderTimerBar();
        await refreshMaps();
        toast('Alle Daten gelöscht.');
      }
      if (!M.settings.user) openSettings(true);
      return;
    }
    M.settings.user = f.user.value.trim() || M.settings.user;
    if (/^\d{2}\/\d{2}$/.test(f.season.value.trim())) M.settings.season = f.season.value.trim();
    await M.settings.save();
    fillFilters();
    renderList();
    if (!M.settings.user) openSettings(true);
  });

  // Auswertung
  $('#btn-stats').onclick = openStats;
  $('#stats-season').onchange = renderStats;
  $('#stats-csv').onclick = shareCsv;
  $('#stats-add').onclick = () => openTimeEdit(null);
  $('#stats-body').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-time]');
    if (b) openTimeEdit(b.dataset.time);
  });
}

function openEdit() {
  const f = $('#dlg-edit form'), m = S.map;
  f.name.value = m.name; f.season.value = m.season || ''; f.revier.value = m.revier || ''; f.note.value = m.note || '';
  $('#edit-meta').textContent = `Datei: ${m.fileName || '–'} · zuletzt geändert ${fmtDate(m.updatedAt)} ${fmtTime(m.updatedAt)} von ${m.updatedBy || '?'}`;
  $('#dlg-edit').showModal();
}

async function openSettings(first) {
  const f = $('#dlg-settings form');
  f.user.value = M.settings.user;
  f.season.value = M.settings.season;
  const est = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  $('#storage-info').textContent = (est ? `Belegt: ${(est.usage / 1e6).toFixed(1)} MB. ` : '') +
    (persisted ? 'Speicher ist dauerhaft geschützt.' : 'Hinweis: App auf den Startbildschirm legen, damit der Browser die Daten nicht aufräumt.');
  if (first) $('#storage-info').textContent = 'Willkommen! Bitte deinen Namen eintragen – er erscheint bei Tracks, Linien und „fertig“-Markierungen.';
  $('#dlg-settings').showModal();
}

// Teilen
let sharePrepared = null;
function openShare() {
  const f = $('#dlg-share form');
  const seasons = [...new Set([M.settings.season, ...S.maps.map((m) => m.season).filter(Boolean)])].sort().reverse();
  f.season.innerHTML = seasons.map((s) => `<option value="${esc(s)}">Saison ${esc(s)}</option>`).join('') + '<option value="alle">Alle Saisons</option>';
  f.season.value = M.settings.season;
  f.withPdf.checked = false;
  $('#dlg-share').showModal();
  prepareShare();
}

async function prepareShare() {
  const f = $('#dlg-share form');
  const btn = f.querySelector('button[value=ok]');
  btn.disabled = true;
  sharePrepared = null;
  const data = await M.buildExport({ season: f.season.value });
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const safeUser = (M.settings.user || 'stand').replace(/[^\wäöüÄÖÜß-]+/g, '');
  // .txt statt .json: Android-Chrome erlaubt beim Teilen nur bestimmte Dateitypen.
  const files = [new File([JSON.stringify(data)], `Mulchstand_${stamp}_${safeUser}.txt`, { type: 'text/plain' })];
  if (f.withPdf.checked) {
    for (const m of data.maps) {
      const pdf = await M.getPdf(m.id);
      if (pdf) files.push(new File([pdf], (m.fileName || m.name + '.pdf').replace(/[\\/]/g, '_'), { type: 'application/pdf' }));
    }
  }
  sharePrepared = { files, data };
  btn.disabled = false;
  btn.textContent = `Teilen (${data.maps.length} Karten, ${data.features.filter((x) => !x.deleted).length} Linien${files.length > 1 ? `, ${files.length - 1} PDFs` : ''})`;
}

async function shareFiles(files, title) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, title });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      console.warn(err);
    }
  }
  // Fallback: erklären und auf Wunsch herunterladen
  pendingDownload = files;
  const ff = /Firefox|FxiOS/.test(navigator.userAgent);
  $('#noshare-text').textContent = (ff
    ? 'Firefox kann aus Web-Apps keine Dateien an WhatsApp übergeben (und auch keine aus WhatsApp empfangen). '
    : 'Dieser Browser kann aus Web-Apps keine Dateien an andere Apps übergeben. ') +
    'Lösung: Die Mulchkarten-Adresse einmal in Chrome öffnen und dort über ⋮ → „App installieren“ einrichten. Die installierte App läuft dann eigenständig, Firefox kann trotzdem dein Standardbrowser bleiben. ' +
    'Achtung: Die Daten liegen pro Browser getrennt – vorher hier „Trotzdem herunterladen“ und die Datei in der Chrome-App importieren.';
  $('#dlg-noshare').showModal();
  return false;
}

let pendingDownload = null;
function downloadFiles(files) {
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
}

function doShare() {
  if (!sharePrepared) return;
  const { files } = sharePrepared;
  shareFiles(files, 'Mulchkarten-Arbeitsstand');   // synchron im Klick starten (iOS)
  $('#dlg-share').close('ok');
}

// Auswertung
function openStats() {
  const seasons = [...new Set([M.settings.season, ...S.maps.map((m) => m.season).filter(Boolean)])].sort().reverse();
  $('#stats-season').innerHTML = seasons.map((s) => `<option>${esc(s)}</option>`).join('') + '<option value="alle">Alle</option>';
  $('#stats-season').value = M.settings.season;
  $('#dlg-stats').showModal();
  renderStats();
}

async function statsData(season) {
  const maps = (await M.getMaps()).filter((m) => season === 'alle' || m.season === season);
  const byId = Object.fromEntries(maps.map((m) => [m.id, m]));
  const tracks = (await M.getFeatures()).filter((f) => f.type === 'track' && byId[f.mapId]);
  const times = (await M.getTimes()).filter((t) => byId[t.mapId]).sort((a, b) => (a.start < b.start ? 1 : -1));
  return { maps, byId, tracks, times };
}

const fmtKm = (m) => (m / 1000).toFixed(1).replace('.', ',');

async function renderStats() {
  const season = $('#stats-season').value;
  const { maps, byId, tracks, times } = await statsData(season);
  const rev = {};
  for (const m of maps) {
    const r = (rev[m.revier || '(ohne Revier)'] ??= { maps: [], h: 0, m: 0, done: 0 });
    const h = times.filter((t) => t.mapId === m.id).reduce((s, t) => s + M.timeHours(t), 0);
    const len = tracks.filter((x) => x.mapId === m.id).reduce((s, x) => s + (x.length || 0), 0);
    r.maps.push({ m, h, len });
    r.h += h; r.m += len; if (m.status === 'fertig') r.done++;
  }
  const people = {};
  for (const t of times) people[t.author || '?'] = (people[t.author || '?'] || 0) + M.timeHours(t);

  let html = '<table class="stats-table"><tr><th>Revier / Karte</th><th>Status</th><th class="n">Zeit</th><th class="n">Track-km</th></tr>';
  for (const [name, r] of Object.entries(rev).sort((a, b) => a[0].localeCompare(b[0], 'de'))) {
    html += `<tr class="rev"><td>${esc(name)}</td><td>${r.done}/${r.maps.length} fertig</td><td class="n">${fmtHours(r.h)}</td><td class="n">${fmtKm(r.m)}</td></tr>`;
    for (const x of r.maps.sort((a, b) => a.m.name.localeCompare(b.m.name, 'de'))) {
      html += `<tr><td>${esc(x.m.name)}</td><td>${STATUS_LABEL[x.m.status]}</td><td class="n">${x.h ? fmtHours(x.h) : '–'}</td><td class="n">${x.len ? fmtKm(x.len) : '–'}</td></tr>`;
    }
  }
  html += '</table>';
  if (Object.keys(people).length) {
    html += '<h3 class="stats-h">Personen</h3><table class="stats-table"><tr><th>Person</th><th class="n">Zeit</th></tr>' +
      Object.entries(people).map(([p, h]) => `<tr><td>${esc(p)}</td><td class="n">${fmtHours(h)}</td></tr>`).join('') + '</table>';
  }
  html += '<h3 class="stats-h">Zeiteinträge</h3>';
  html += times.length
    ? '<table class="stats-table entries"><tr><th>Datum</th><th>Karte</th><th>Zeit</th><th class="n">Dauer</th><th></th></tr>' +
      times.map((t) => `<tr><td>${fmtDate(t.start)}<br><span class="muted">${esc(t.author)}</span></td><td>${esc(byId[t.mapId].name)}<br><span class="muted">${esc(byId[t.mapId].revier || '')}</span></td>` +
        `<td>${fmtTime(t.start)}–${t.end ? fmtTime(t.end) : 'läuft'}</td><td class="n">${fmtHours(M.timeHours(t))}</td>` +
        `<td>${t.end ? `<button type="button" data-time="${t.id}" aria-label="Bearbeiten">✎</button>` : ''}</td></tr>`).join('') + '</table>'
    : '<p class="muted">Noch keine Zeiten erfasst. Zeit startest du in der Kartenansicht mit ⏱.</p>';
  $('#stats-body').innerHTML = maps.length ? html : '<p class="muted">Keine Karten in dieser Saison.</p>';
}

async function shareCsv() {
  const season = $('#stats-season').value;
  const { byId, times } = await statsData(season);
  const rows = [['Datum', 'Person', 'Saison', 'Revier', 'Karte', 'Beginn', 'Ende', 'Stunden']];
  for (const t of times.filter((x) => x.end).reverse()) {
    const m = byId[t.mapId];
    rows.push([fmtDate(t.start), t.author, m.season, m.revier, m.name, fmtTime(t.start), fmtTime(t.end), M.timeHours(t).toFixed(2).replace('.', ',')]);
  }
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  await shareFiles([new File([csv], `Mulchzeiten_${season.replace('/', '-')}.csv`, { type: 'text/csv' })], 'Mulchzeiten');
}

// ---------- Zeiterfassung ----------
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
const mapName = (id) => S.maps.find((m) => m.id === id)?.name || 'Karte';

async function loadTimer() {
  S.timer = await M.getRunningTime();
  renderTimerBar();
}

function bindTimer() {
  setInterval(tickTimer, 1000);
  document.querySelectorAll('.timer-bar').forEach((bar) => {
    bar.innerHTML = '<span>⏱</span><button class="tb-name"></button><span class="tb-time"></span><button class="tb-stop">Stopp</button>';
    bar.querySelector('.tb-stop').onclick = () => stopTime();
    bar.querySelector('.tb-name').onclick = () => {
      const m = S.maps.find((x) => x.id === S.timer?.mapId);
      if (m?.hasPdf && S.map?.id !== m.id) openMap(m.id);
    };
  });
  $('#dlg-switch').addEventListener('close', onSwitchClose);
  $('#dlg-time').addEventListener('close', onTimeEditClose);
}

function renderTimerBar() {
  const t = S.timer;
  document.querySelectorAll('.timer-bar').forEach((bar) => {
    bar.hidden = !t;
    if (!t) return;
    const m = S.maps.find((x) => x.id === t.mapId);
    bar.querySelector('.tb-name').textContent = `${m?.name || 'Karte'}${m?.revier ? ' · ' + m.revier : ''}`;
  });
  tickTimer();
  const tb = $('#t-time');
  const onThis = t && S.map && t.mapId === S.map.id;
  tb.classList.toggle('on', !!onThis);
  $('#t-time-lbl').textContent = onThis ? 'Stopp' : t ? 'Wechseln' : 'Zeit';
}

function tickTimer() {
  if (!S.timer) return;
  const txt = fmtClock(Date.now() - new Date(S.timer.start));
  document.querySelectorAll('.timer-bar .tb-time').forEach((el) => (el.textContent = txt));
}

async function startTime(mapId, startIso) {
  S.timer = await M.saveTime(M.newTime({ mapId, start: startIso || M.now() }));
  S.cand = null;
  S.declined.clear();
  const m = S.maps.find((x) => x.id === mapId);
  if (m?.status === 'offen') {
    await M.updateMap(mapId, { status: 'arbeit' });
    S.maps = await M.getMaps();
    if (S.map?.id === mapId) { S.map = await M.getMap(mapId); $('#map-status').value = S.map.status; }
  }
  renderTimerBar();
  renderList();
}

async function stopTime(endIso) {
  const t = S.timer;
  if (!t) return;
  S.timer = null;
  t.end = endIso || M.now();
  if (new Date(t.end) <= new Date(t.start)) await M.deleteTime(t.id);   // Länge 0 -> verwerfen
  else await M.saveTime(t);
  renderTimerBar();
  renderList();
  if (!endIso) toast(`Zeit gestoppt: ${mapName(t.mapId)} · ${fmtHours(M.timeHours(t))}`);
}

/** Zählstelle wechseln. mode 'anfahrt': ab dem Verlassen der alten Karte zählt die neue. */
async function switchTime(mapId, mode) {
  const old = S.timer;
  let at = M.now();
  if (mode === 'anfahrt' && old?.lastInsideAt && old.lastInsideAt > old.start) at = old.lastInsideAt;
  if (old) await stopTime(at);
  await startTime(mapId, at);
  toast(`Zeit läuft jetzt für „${mapName(mapId)}“${mode === 'anfahrt' ? ` (ab ${fmtTime(at)})` : ''}.`);
}

function timeToolClick() {
  if (!S.map) return;
  if (!S.timer) { startTime(S.map.id); toast(`Zeit gestartet: ${S.map.name}`); return; }
  if (S.timer.mapId === S.map.id) { stopTime(); return; }
  promptSwitch(S.map, true);
}

let switchTarget = null;
function promptSwitch(m, manual) {
  const dlg = $('#dlg-switch');
  if (dlg.open) return;
  switchTarget = m;
  const t = S.timer;
  const from = mapName(t.mapId);
  const hasLeft = t.lastInsideAt && t.lastInsideAt > t.start;
  $('#sw-text').innerHTML = manual
    ? `Die Zeit läuft gerade für <b>${esc(from)}</b> (seit ${fmtTime(t.start)}).`
    : `Du bist jetzt auf <b>${esc(m.name)}</b>${m.revier ? ` (${esc(m.revier)})` : ''}.<br>Die Zeit läuft noch für <b>${esc(from)}</b>.`;
  const anf = $('#sw-anfahrt');
  anf.hidden = !hasLeft;
  anf.textContent = hasLeft ? `Wechseln mit Anfahrt – zählt ab ${fmtTime(t.lastInsideAt)} (Verlassen von „${from}“)` : '';
  $('#sw-jetzt').textContent = `Ab jetzt für „${m.name}“ zählen`;
  $('#sw-nein').textContent = manual ? 'Abbrechen' : `Nicht wechseln – Fahrt gehört zu „${from}“`;
  $('#sw-hint').textContent = manual ? '' : 'Bei „Nicht wechseln“ fragt die App für diese Karte 30 Minuten nicht mehr.';
  dlg.dataset.manual = manual ? '1' : '';
  navigator.vibrate?.([200, 100, 200]);
  dlg.showModal();
}

async function onSwitchClose() {
  const dlg = $('#dlg-switch'), v = dlg.returnValue, m = switchTarget;
  switchTarget = null;
  S.cand = null;
  if (!m) return;
  if (v === 'anfahrt' || v === 'jetzt') await switchTime(m.id, v);
  else if (v === 'stop') await stopTime();
  else if (!dlg.dataset.manual) S.declined.set(m.id, Date.now() + 30 * 60e3);
}

let lastInsideSaved = 0;
/** Bei jeder GPS-Position: prüfen, ob man die Karte der laufenden Zeit verlassen und eine andere betreten hat. */
function checkZone() {
  const t = S.timer, p = S.pos;
  if (!t || !p || p.acc > 50) return;
  const ll = [p.lat, p.lon];
  const cur = S.maps.find((m) => m.id === t.mapId);
  if (cur?.georef && inPolygon(ll, cur.georef.footprint)) {
    t.lastInsideAt = M.now();
    S.cand = null;
    S.declined.clear();
    if (Date.now() - lastInsideSaved > 30000) { lastInsideSaved = Date.now(); db.put('times', t); }
    return;
  }
  const nowMs = Date.now();
  const hits = S.maps.filter((m) => m.id !== t.mapId && m.georef && m.status !== 'fertig' && m.season === M.settings.season &&
    !((S.declined.get(m.id) || 0) > nowMs) && inPolygon(ll, m.georef.footprint));
  if (!hits.length) { S.cand = null; return; }
  // bei Überlappung die kleinste (genaueste) Karte nehmen
  const area = (m) => { const b = m.georef.bbox; return (b[2] - b[0]) * (b[3] - b[1]); };
  const c = hits.sort((a, b) => area(a) - area(b))[0];
  if (S.cand?.mapId !== c.id) { S.cand = { mapId: c.id, since: nowMs, n: 1 }; return; }
  S.cand.n++;
  if (S.cand.n >= 2 && nowMs - S.cand.since >= S.dwellMs && document.visibilityState === 'visible') promptSwitch(c, false);
}

// Zeiteintrag bearbeiten / nachtragen
let editTimeId = null;
async function openTimeEdit(id) {
  editTimeId = id;
  const f = $('#dlg-time form');
  const t = id ? await M.getTime(id) : null;
  const maps = S.maps.slice().sort((a, b) => (a.revier || '').localeCompare(b.revier || '', 'de') || a.name.localeCompare(b.name, 'de'));
  f.mapId.innerHTML = maps.map((m) => `<option value="${m.id}">${esc(m.name)}${m.revier ? ' · ' + esc(m.revier) : ''} (${esc(m.season || '')})</option>`).join('');
  const nowD = new Date();
  f.mapId.value = t?.mapId || S.map?.id || maps[0]?.id || '';
  f.start.value = toLocalInput(t?.start || new Date(nowD - 3600e3).toISOString());
  f.end.value = toLocalInput(t?.end || nowD.toISOString());
  $('#time-title').textContent = t ? 'Zeiteintrag bearbeiten' : 'Zeit nachtragen';
  $('#time-del').hidden = !t;
  $('#time-meta').textContent = t ? `Erfasst von ${t.author || '?'}` : '';
  $('#dlg-time').showModal();
}

async function onTimeEditClose() {
  const dlg = $('#dlg-time'), f = dlg.querySelector('form'), v = dlg.returnValue;
  if (v === 'delete' && editTimeId) {
    if (confirm('Zeiteintrag löschen?')) await M.deleteTime(editTimeId);
  } else if (v === 'ok') {
    const start = new Date(f.start.value), end = new Date(f.end.value);
    if (!(end > start)) { toast('Ende muss nach dem Beginn liegen.'); return; }
    const t = editTimeId ? await M.getTime(editTimeId) : M.newTime({ mapId: f.mapId.value });
    Object.assign(t, { mapId: f.mapId.value, start: start.toISOString(), end: end.toISOString() });
    await M.saveTime(t);
  }
  if ($('#dlg-stats').open) renderStats();
}

init().catch((e) => { console.error(e); toast('Fehler beim Start: ' + e.message, 10000); });

// Für Tests
window.__mk = { S, M, handleFiles, openMap, checkZone };
