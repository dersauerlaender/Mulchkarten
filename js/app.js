// Mulchkarten – Oberfläche
import { db } from './db.js';
import * as M from './model.js';
import { makeTransform, inPolygon, distToPolygon, distMeters, bboxOverlap } from './georef.js';
import { initOverview } from './overview.js';
import { oneFingerZoom, twoFinger } from './gestures.js';
import { getBearing, setBearing, onBearing, rotPt, clientToLocal, animateBearing, updateCompass } from './rotation.js';

export const APP_VERSION = '1.9.2';
const d3 = window.d3;
const $ = (s) => document.querySelector(s);
const KINDS = ['erledigt', 'offen', 'hinweis'];
const KIND_LABEL = { erledigt: 'Erledigt', offen: 'Offen', hinweis: 'Hinweis' };
const STATUS_LABEL = { offen: 'Offen', arbeit: 'In Arbeit', fertig: 'Fertig' };
const POI_CATS = {
  parken: { icon: '🅿️', label: 'Parkplatz / Abstellplatz' },
  wenden: { icon: '↩️', label: 'Wendemöglichkeit' },
  schranke: { icon: '🚧', label: 'Schranke / Sperre' },
  gefahr: { icon: '⚠️', label: 'Gefahr / Hindernis' },
  treff: { icon: '🤝', label: 'Treffpunkt' },
  info: { icon: '📌', label: 'Sonstiges' },
};
const poiIcon = (p) => (POI_CATS[p.kind] || POI_CATS.info).icon;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

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
/** Meldung oben; optional mit Aktion, z. B. { label: 'Wiederherstellen', fn } */
function toast(msg, ms = 3500, action = null) {
  const t = $('#toast');
  t.textContent = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.append(span);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { t.hidden = true; action.fn(); };
    t.append(b);
  }
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
  document.body.dataset.view = id;
  document.querySelectorAll('#navbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === id));
  closeFab();
}

// ---------- Navigationsleiste ----------
const activeView = () => document.querySelector('.view.active')?.id || 'view-list';

function showMain(id) {
  showView(id);
  if (id === 'view-overview') { fillOvSeason(); ov.show(filteredMaps()); }
  else if (id === 'view-times') openTimesView();
  else renderList();
}

/** Wechsel über die Navigationsleiste. Liste ist "Start": von dort neuer Verlaufseintrag, sonst ersetzen. */
function navTo(id) {
  const cur = activeView();
  if (cur === id) return;
  if (id === 'view-list') {
    if (history.state?.v && history.state.v !== 'view-list') { history.back(); return; }
    showMain(id);
    return;
  }
  if (cur === 'view-list') history.pushState({ v: id }, '');
  else history.replaceState({ v: id }, '');
  showMain(id);
}

// Saison-Auswahl der Übersicht (gekoppelt an den Filter der Kartenliste)
function fillOvSeason() {
  const sel = $('#ov-season'), src = $('#f-season');
  sel.innerHTML = src.innerHTML;
  sel.value = src.value;
}

// ---------- Aktionsknopf (FAB-Menü) ----------
function fabActions() {
  const imp = ['📄', 'Karten / Stand importieren', () => $('#file-input').click()];
  const share = ['⇪', 'Stand teilen', openShare];
  switch (activeView()) {
    case 'view-overview': return [['📍', 'POI an meiner Position', () => ov.addPoiHere()], imp, share];
    case 'view-times': return [['＋', 'Zeit nachtragen', () => openTimeEdit(null)], ['📊', 'Zeiten als CSV teilen', shareCsv], share];
    default: return [imp, share];
  }
}
function openFab() {
  const acts = fabActions();
  const menu = $('#fab-menu');
  menu.innerHTML = acts.map(([i, l], k) => `<button data-k="${k}" style="animation-delay:${(acts.length - 1 - k) * 30}ms"><span class="fi">${i}</span>${l}</button>`).join('');
  menu.querySelectorAll('button').forEach((b) => (b.onclick = () => { const a = acts[+b.dataset.k]; closeFab(); a[2](); }));
  menu.hidden = false;
  $('#fab-scrim').hidden = false;
  $('#fab').setAttribute('aria-expanded', 'true');
  // Android-Zurück schließt das Menü (statt die App zu beenden)
  if ('CloseWatcher' in window) {
    fabWatcher = new CloseWatcher();
    fabWatcher.onclose = () => { fabWatcher = null; closeFab(); };
  } else {
    history.pushState({ v: activeView(), fab: 1 }, '');
  }
}
let fabWatcher = null;
function closeFab() {
  if (!$('#fab-menu') || !fabOpen()) return;
  $('#fab-menu').hidden = true;
  $('#fab-scrim').hidden = true;
  $('#fab').setAttribute('aria-expanded', 'false');
  if (fabWatcher) { const w = fabWatcher; fabWatcher = null; w.destroy(); }
  if (history.state?.fab) history.replaceState({ v: activeView() }, '');
}
const fabOpen = () => $('#fab').getAttribute('aria-expanded') === 'true';

function bindNav() {
  document.querySelectorAll('#navbar button').forEach((b) => (b.onclick = () => navTo(b.dataset.view)));
  $('#fab').onclick = () => (fabOpen() ? closeFab() : openFab());
  $('#fab-scrim').onclick = closeFab;
  document.querySelectorAll('.btn-settings').forEach((b) => (b.onclick = () => openSettings(false)));
  $('#ov-season').onchange = () => {
    $('#f-season').value = $('#ov-season').value;
    renderList();                       // speichert den Filter
    ov.update(filteredMaps());
    ov.fitAll(true);
  };
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
  bindHistory();
  bindNav();
  document.body.dataset.view = 'view-list';
  bindUpdate();
  ov = initOverview({
    esc, toast, openMap, getThumb: M.getThumb,
    getPois: () => S.pois || [],
    getLines: () => S.lines || [],
    poiIcon, pointPopupHTML, bindPointPopup, drawPin,
    addPoiAtPos: () => {
      if (!S.pos) { toast('Kein GPS – tippe stattdessen auf die Karte und wähle „Als POI speichern“.'); return; }
      openPoiDialog([+S.pos.lat.toFixed(7), +S.pos.lon.toFixed(7)], null);
    },
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
  setTimeout(() => checkUpdate(false), 3000);
}

// ---------- Updates ----------
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

let remoteInfo = null;
/** Fragt version.json beim Server ab. manual = vom Knopf ausgelöst (dann immer Rückmeldung). */
async function checkUpdate(manual) {
  if (!navigator.onLine) { if (manual) toast('Kein Internet – Update-Prüfung nicht möglich.'); return; }
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Server antwortet ${res.status}`);
    remoteInfo = await res.json();
  } catch (err) {
    if (manual) toast(`Update-Prüfung fehlgeschlagen: ${err.message}`);
    return;
  }
  const newer = cmpVersion(remoteInfo.version, APP_VERSION) > 0;
  $('#update-bar').hidden = !newer;
  if (newer) $('#update-text').textContent = `Neue Version ${remoteInfo.version} verfügbar (du hast ${APP_VERSION})`;
  if (manual) {
    if (newer) { $('#dlg-settings').close('cancel'); toast(`Version ${remoteInfo.version} ist verfügbar – oben auf „Aktualisieren“ tippen.`); }
    else toast(`Du hast die neueste Version (${APP_VERSION}).`);
  }
}

/** Holt alle Dateien frisch vom Server, leert den App-Cache und lädt neu. Daten bleiben erhalten. */
async function doUpdate() {
  if (S.rec) { toast('Bitte zuerst die Track-Aufnahme beenden.'); return; }
  busy('Neue Version wird geladen …');
  try {
    const assets = remoteInfo?.assets || [];
    for (const u of assets) await fetch(u, { cache: 'reload' });   // HTTP-Cache auffrischen
    for (const k of await caches.keys()) if (k !== 'share-inbox') await caches.delete(k);
    const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
    for (const r of regs) await r.unregister();
  } catch (err) {
    busy(false);
    toast(`Update fehlgeschlagen: ${err.message}`);
    return;
  }
  location.replace(location.pathname + '?v=' + Date.now());
}

function bindUpdate() {
  $('#update-go').onclick = doUpdate;
  $('#btn-update').onclick = () => checkUpdate(true);
  $('#btn-about').onclick = () => {
    $('#dlg-settings').close('cancel');
    $('#about-version').textContent = APP_VERSION;
    $('#dlg-about').showModal();
  };
  window.addEventListener('online', () => checkUpdate(false));
}

let ov;
async function refreshMaps() {
  S.maps = await M.getMaps();
  const feats = await M.getFeatures();
  S.pois = feats.filter((f) => f.type === 'poi');
  S.lines = feats.filter((f) => f.type !== 'poi' && f.coords?.length > 1);
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
  // 1) Stand-Dateien lesen; eingebettete Karten-PDFs auspacken
  const states = [];
  for (const f of others) {
    busy('Datei wird gelesen …');
    try {
      const data = parseState(await f.text());
      if (data.pdfs?.length) { busy(`${data.pdfs.length} Karten werden ausgepackt …`); pdfs.push(...(await M.extractPdfs(data))); }
      states.push({ f, data });
    } catch (err) {
      console.error(err);
      msgs.push(`✗ ${f.name}: ${err instanceof SyntaxError ? 'keine gültige Mulchkarten-Datei' : err.message}`);
    }
  }
  // 2) Karten zuerst, damit der Stand sie danach direkt zuordnen kann
  const cnt = { neu: 0, doppelt: 0, ergänzt: 0 };
  const neu = [];
  let n = 0;
  for (const f of pdfs) {
    busy(`Karte ${++n}/${pdfs.length} wird eingelesen …\n${f.name}`);
    try {
      const r = await M.importPdfFile(f);
      cnt[r.result]++;
      if (r.result === 'neu') neu.push(r.map.name);
    } catch (err) {
      console.error(err);
      msgs.push(`✗ ${f.name}: ${err.message}`);
    }
  }
  if (pdfs.length) {
    msgs.unshift(pdfs.length === 1 && neu.length === 1 ? `Neu: „${neu[0]}“`
      : `Karten: ${cnt.neu} neu, ${cnt.ergänzt ? cnt.ergänzt + ' ergänzt, ' : ''}${cnt.doppelt} schon vorhanden`);
  }
  // 3) Stände zusammenführen
  for (const { f, data } of states) {
    busy('Arbeitsstand wird übernommen …');
    try {
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
  history.replaceState({ v: 'view-list' }, '', location.pathname);
  await handleFiles(files);
}

// ---------- Kartenansicht ----------
let svg, gRot, gZoom, gImg, gFeat, gLive, gPoi, gPick, gPos;
let gest = null;   // laufende Zoom-/Verschiebe-Geste in der Kartenansicht

function bindMap() {
  svg = d3.select('#svg');
  // gRot: Drehung um die Bildschirmmitte; darin der Zoom. Der Zoom hängt an gRot,
  // damit Verschieben/Zoomen in gedrehtem Zustand richtig herum funktioniert.
  gRot = svg.append('g').attr('class', 'rot');
  gRot.append('rect').attr('x', -20000).attr('y', -20000).attr('width', 40000).attr('height', 40000)
    .attr('fill', 'none').attr('pointer-events', 'all');
  gZoom = gRot.append('g');
  gImg = gZoom.append('g');
  gFeat = gZoom.append('g');
  gLive = gZoom.append('g');
  gPoi = gRot.append('g');
  gPick = gRot.append('g').attr('pointer-events', 'none');
  gPos = gRot.append('g').attr('pointer-events', 'none');
  new MutationObserver(() => { if (!$('#map-pop').innerHTML && S.pick) { S.pick = null; drawPick(); } })
    .observe($('#map-pop'), { childList: true });
  svg.on('contextmenu', (e) => e.preventDefault());

  S.zoom = d3.zoom()
    .filter((ev) => {
      if (S.draw) return ev.type === 'wheel' || (ev.touches && ev.touches.length >= 2);
      return (!ev.ctrlKey || ev.type === 'wheel') && !ev.button;
    })
    .on('start', (ev) => { gest = { k0: S.zt.k, user: !!ev.sourceEvent, zoomed: false }; })
    .on('zoom', (ev) => {
      S.zt = ev.transform;
      gZoom.attr('transform', ev.transform);
      // Mitführen: Zoomen behält es bei, nur reines Verschieben beendet es (wie Google Maps)
      if (ev.sourceEvent && S.follow && gest) {
        gest.user = true;
        if (Math.abs(ev.transform.k - gest.k0) > 1e-9) gest.zoomed = true;
        else if (!gest.zoomed) setFollow(false);
      }
      drawPos();
      drawPois();
      drawPick();
    })
    .on('end', () => {
      // nach einer Zoom-Geste wieder auf die Position zentrieren
      if (gest?.user && gest.zoomed && S.follow) centerOnPos(true, S.zt.k);
      gest = null;
    });
  gRot.call(S.zoom);
  // Doppeltippen / Doppeltippen + Ziehen = Ein-Finger-Zoom
  S.ofz = oneFingerZoom(svg, S.zoom, { zoomSel: gRot, enabled: () => !S.draw, onStart: () => { cancelLp(); select(null); } });
  // Zwei Finger: zoomen, verschieben, drehen
  twoFinger(svg.node(), gRot, S.zoom, {
    getR: mapRot,
    setR: (r) => setBearing(-r - S.phi),
    onStart: () => { cancelLp(); cancelStroke(); },
    onEnd: () => { if (S.follow) centerOnPos(true, S.zt.k); },
  });
  onBearing(() => { if (S.map) applyRot(); });
  $('#t-north').onclick = () => animateBearing(0);

  // Freihand zeichnen
  const node = svg.node();
  const pointers = new Set();
  // Langes Drücken: Punkt-Menü (Navigieren / POI)
  let lp = null;
  const cancelLp = () => { if (lp) { clearTimeout(lp.t); lp = null; } };
  node.addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId);
    if (!S.draw && pointers.size === 1 && !S.ofz.busy()) {
      const ll = toLatLon(e);
      lp = { x: e.clientX, y: e.clientY, t: setTimeout(() => { lp = null; S.lpDone = Date.now(); navigator.vibrate?.(30); showMapPopup(ll, null); }, 550) };
    } else cancelLp();
    if (!S.draw) return;
    if (pointers.size > 1) { cancelStroke(); return; }
    node.setPointerCapture(e.pointerId);
    S.stroke = { id: e.pointerId, pts: [toLatLon(e)], last: [e.clientX, e.clientY] };
    renderLive();
  });
  node.addEventListener('pointermove', (e) => {
    if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) cancelLp();
    if (!S.stroke || e.pointerId !== S.stroke.id) return;
    if (Math.hypot(e.clientX - S.stroke.last[0], e.clientY - S.stroke.last[1]) < 4) return;
    S.stroke.last = [e.clientX, e.clientY];
    S.stroke.pts.push(toLatLon(e));
    renderLive();
  });
  const end = async (e) => {
    pointers.delete(e.pointerId);
    cancelLp();
    if (!S.stroke || e.pointerId !== S.stroke.id) return;
    const pts = S.stroke.pts;
    S.stroke = null;
    renderLive();
    if (pts.length >= 2) {
      const f = await M.saveFeature(M.newFeature({ type: 'draw', kind: S.kind, mapId: S.map.id, coords: pts }));
      S.undo.push(f.id);
      updateUndo();
      await reloadFeatures();
    }
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); cancelLp(); cancelStroke(); });

  // Auswahl
  svg.on('click', (ev) => {
    if (S.draw || S.ofz.busy()) return;
    if (Date.now() - (S.lpDone || 0) < 600) return;   // Klick nach langem Drücken ignorieren
    const poiEl = ev.target.closest?.('[data-poi]');
    if (poiEl) {
      const p = S.features.find((f) => f.id === poiEl.dataset.poi);
      if (p) { select(null); showMapPopup(p.coords[0], p); }
      return;
    }
    if ($('#map-pop').innerHTML) { $('#map-pop').innerHTML = ''; return; }
    const hit = ev.target.closest?.('.hit');
    select(hit ? hit.dataset.id : null);
  });

  $('#btn-back').onclick = () => history.back();
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
    await removeWithRestore(S.selected, 'Linie gelöscht.');
    select(null);
  };
  $('#sel-close').onclick = () => select(null);
  window.addEventListener('resize', () => S.map && applyRot());
}

function cancelStroke() { S.stroke = null; renderLive(); }

// ---------- Drehung der Kartenansicht ----------
/** Drehwinkel der Karte auf dem Bildschirm: Blickrichtung minus Nordabweichung des Kartenbilds */
const mapRot = () => -getBearing() - (S.phi || 0);
function stageCenter() { const r = svg.node().getBoundingClientRect(); return [r.width / 2, r.height / 2]; }
function applyRot() {
  const [cx, cy] = stageCenter();
  gRot.attr('transform', `rotate(${mapRot()},${cx},${cy})`);
  drawPos();
  drawPois();
  drawPick();
  updateCompass($('#t-north'));
}
/** lokale (ungedrehte) Koordinaten -> Bildschirm (relativ zum SVG) */
const toScreen = (p) => rotPt(p, mapRot(), stageCenter());

function toLatLon(e) {
  const [u, v] = S.zt.invert(clientToLocal(gRot.node(), e.clientX, e.clientY));
  return S.T.toLatLon(u, v).map((x) => +x.toFixed(7));
}
const toPx = ([lat, lon]) => S.T.toPixel(lat, lon);

async function openMap(id) {
  const m = await M.getMap(id);
  const blob = await M.getImage(id);
  if (!blob) { toast('Kartenbild fehlt – bitte PDF erneut importieren.'); return; }
  const cur = document.querySelector('.view.active')?.id;
  if (cur && cur !== 'view-map') S.returnView = cur;
  // Verlauf: Karte -> Karte ersetzt den Eintrag, sonst neuer Eintrag (Android-Zurück)
  if (cur === 'view-map') history.replaceState({ v: 'view-map' }, '');
  else history.pushState({ v: 'view-map' }, '');
  S.map = m;
  S.T = makeTransform(m.georef.coef);
  S.mPerPx = distMeters(S.T.toLatLon(0, 0), S.T.toLatLon(100, 0)) / 100;
  // Wohin zeigt Norden im Kartenbild? (Winkel zur Bild-Senkrechten, meist ~0°)
  {
    const b = m.georef.bbox, c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const p0 = S.T.toPixel(c[0], c[1]), p1 = S.T.toPixel(c[0] + 0.001, c[1]);
    S.phi = (Math.atan2(p1[0] - p0[0], -(p1[1] - p0[1])) * 180) / Math.PI;
  }
  S.undo = [];
  updateUndo();
  $('#map-pop').innerHTML = '';
  select(null);
  setDraw(false);
  $('#map-title').textContent = m.name;
  $('#map-status').value = m.status;
  showView('view-map');
  applyRot();

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

/** Karte verlassen (vom Verlauf aus aufgerufen) */
function leaveMap(target) {
  if (S.rec) stopRec();
  S.map = null;
  setDraw(false);
  showView(target);
  refreshMaps();
  if (target === 'view-overview') ov.update(filteredMaps());
}

// Android-Zurück / Browser-Zurück
function bindHistory() {
  history.replaceState({ v: 'view-list' }, '');
  window.addEventListener('popstate', (e) => {
    const cur = document.querySelector('.view.active')?.id || 'view-list';
    const target = e.state?.v || 'view-list';
    // offener Dialog: nur den Dialog schließen, Ansicht bleibt
    if (fabOpen()) { closeFab(); return; }
    const dlg = document.querySelector('dialog[open]');
    if (dlg) {
      dlg.close('cancel');
      history.pushState({ v: cur }, '');
      return;
    }
    if (cur === 'view-map' && target !== 'view-map') {
      if (S.rec && !confirm('Track-Aufnahme läuft. Beenden und speichern?')) {
        history.pushState({ v: 'view-map' }, '');
        return;
      }
      leaveMap(target);
      return;
    }
    if (target === 'view-map') { if (!S.map) history.back(); return; }
    showMain(target);
  });
}

/** Ganze Karte einpassen. Liefert den Einpass-Zoom. */
function fitMap(animate) {
  const m = S.map;
  const { width: W, height: H } = $('#stage').getBoundingClientRect();
  // gedrehtes Kartenbild muss ganz hineinpassen
  const a = (mapRot() * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const k0 = Math.min(W / (m.width * c + m.height * s), H / (m.width * s + m.height * c));
  S.zoom.scaleExtent([k0 * 0.5, 4]).translateExtent([[-m.width, -m.height], [m.width * 2, m.height * 2]]);
  const t = d3.zoomIdentity.translate(W / 2 - (m.width * k0) / 2, H / 2 - (m.height * k0) / 2).scale(k0);
  (animate ? gRot.transition().duration(400) : gRot).call(S.zoom.transform, t);
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
  const data = S.features.filter((f) => f.type !== 'poi').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  drawPois();
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
function drawPois() {
  if (!S.map || !gPoi) return;
  const pois = S.features.filter((f) => f.type === 'poi');
  const g = gPoi.selectAll('g.poi').data(pois, (p) => p.id).join((e) => {
    const ge = e.append('g').attr('class', 'poi').style('cursor', 'pointer');
    ge.append('circle').attr('r', 17);
    ge.append('text').attr('class', 'poi-icon').attr('dy', '0.35em');
    ge.append('text').attr('class', 'poi-label').attr('y', 31);
    return ge;
  });
  const rr = -mapRot();   // Symbole bleiben aufrecht
  g.attr('data-poi', (p) => p.id)
    .attr('transform', (p) => `translate(${S.zt.apply(toPx(p.coords[0]))}) rotate(${rr})`);
  g.select('.poi-icon').text(poiIcon);
  g.select('.poi-label').text((p) => p.name || '');
}

// ---------- Punkt-Fenster: Navigation, Teilen, POI ----------
const fmtLL = ([lat, lon]) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
const gmapsUrl = ([lat, lon]) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;

function pointPopupHTML(ll, poi) {
  const cat = poi ? POI_CATS[poi.kind] || POI_CATS.info : null;
  const dist = S.pos ? ` · ${fmtDist(distMeters([S.pos.lat, S.pos.lon], ll))} Luftlinie` : '';
  return `<div class="pt-card">
    <div class="pt-head"><span class="pt-icon">${poi ? cat.icon : '📍'}</span><div>
      <b>${poi ? esc(poi.name || cat.label) : 'Gewählter Punkt'}</b>
      <small>${poi ? esc(cat.label) + ' · ' : ''}${fmtLL(ll)}${dist}</small>
      ${poi ? `<small>von ${esc(poi.author || '?')}, ${fmtDate(poi.updatedAt || poi.createdAt)}</small>` : ''}
    </div></div>
    ${poi?.note ? `<div class="pt-note">${esc(poi.note)}</div>` : ''}
    <div class="pt-acts">
      <button class="go" data-pt="nav">🧭 Navigation</button>
      <button data-pt="gmaps">Google Maps</button>
      <button data-pt="share">Teilen</button>
      <button data-pt="poi">${poi ? '✎ Bearbeiten' : '＋ Als POI speichern'}</button>
    </div></div>`;
}

function bindPointPopup(el, ll, poi) {
  const label = poi ? poi.name || (POI_CATS[poi.kind] || POI_CATS.info).label : 'Ziel';
  el.querySelectorAll('[data-pt]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    const a = b.dataset.pt;
    if (a === 'nav') {
      // Android: geo-Link -> Auswahl der Navi-App (Google Maps, OsmAnd, Waze …); iPhone: Apple Karten
      if (isIOS) window.open(`https://maps.apple.com/?daddr=${ll[0]},${ll[1]}&dirflg=d`, '_blank');
      else location.href = `geo:${ll[0]},${ll[1]}?q=${ll[0]},${ll[1]}(${encodeURIComponent(label)})`;
    } else if (a === 'gmaps') {
      window.open(gmapsUrl(ll), '_blank');
    } else if (a === 'share') {
      const text = `${label}: ${gmapsUrl(ll)}`;
      try {
        if (navigator.share) await navigator.share({ title: label, text });
        else { await navigator.clipboard.writeText(text); toast('Link kopiert.'); }
      } catch (err) { if (err.name !== 'AbortError') toast('Teilen nicht möglich.'); }
    } else if (a === 'poi') {
      el.innerHTML = '';
      openPoiDialog(ll, poi);
    }
  }));
  el.querySelector('.ov-close')?.addEventListener('click', (e) => { e.stopPropagation(); el.innerHTML = ''; });
}

/** Stecknadel an angetippter Stelle; Spitze = genaue Position */
function drawPin(g, x, y) {
  g.append('ellipse').attr('cx', x).attr('cy', y).attr('rx', 6).attr('ry', 2.5).attr('fill', '#0005');
  g.append('path').attr('d', 'M0,0 C-3,-9 -13,-14 -13,-25 A13,13 0 1 1 13,-25 C13,-14 3,-9 0,0 Z').attr('transform', `translate(${x},${y})`)
    .attr('fill', '#dc2626').attr('stroke', '#fff').attr('stroke-width', 2.5);
  g.append('circle').attr('cx', x).attr('cy', y - 25).attr('r', 4.5).attr('fill', '#fff');
}

function drawPick() {
  if (!gPick) return;
  gPick.selectAll('*').remove();
  if (!S.pick || !S.map) return;
  const [x, y] = S.zt.apply(toPx(S.pick));
  drawPin(gPick.append('g').attr('transform', `rotate(${-mapRot()},${x},${y})`), x, y);
}

function showMapPopup(ll, poi) {
  S.pick = poi ? null : ll;
  drawPick();
  const el = $('#map-pop');
  el.innerHTML = '<button class="ov-close" aria-label="Schließen">✕</button>' + pointPopupHTML(ll, poi);
  bindPointPopup(el, ll, poi);
  // Punkt sichtbar über dem Fenster halten
  requestAnimationFrame(() => {
    const sr = svg.node().getBoundingClientRect(), pr = el.getBoundingClientRect();
    const free = pr.top - sr.top;
    const [x, y] = toScreen(S.zt.apply(toPx(ll)));
    const dy = y > free - 45 || y < 45 ? free / 2 - y : 0;
    const dx = x < 30 || x > sr.width - 30 ? sr.width / 2 - x : 0;
    if (dx || dy) {
      setFollow(false);
      const [lx, ly] = rotPt([dx, dy], -mapRot());   // Bildschirmverschiebung -> lokale Verschiebung
      gRot.transition().duration(300).call(S.zoom.translateBy, lx / S.zt.k, ly / S.zt.k);
    }
  });
}

let poiEdit = null;
function openPoiDialog(ll, poi) {
  ll = ll.map((x) => +(+x).toFixed(7));
  poiEdit = { ll, poi };
  const f = $('#dlg-poi form');
  f.cat.innerHTML = Object.entries(POI_CATS).map(([k, c]) => `<option value="${k}">${c.icon} ${c.label}</option>`).join('');
  f.cat.value = poi?.kind || 'parken';
  f.name.value = poi?.name || '';
  f.note.value = poi?.note || '';
  $('#poi-title').textContent = poi ? 'POI bearbeiten' : 'Neuer POI';
  $('#poi-del').hidden = !poi;
  $('#poi-meta').textContent = `${fmtLL(ll)}${poi ? ` · angelegt von ${poi.author || '?'}` : ''} · wird mit dem Arbeitsstand geteilt`;
  $('#dlg-poi').showModal();
}

async function onPoiClose() {
  const dlg = $('#dlg-poi'), f = dlg.querySelector('form'), v = dlg.returnValue;
  const { ll, poi } = poiEdit || {};
  poiEdit = null;
  if (!ll) return;
  if (v === 'delete' && poi) {
    if (!confirm('POI für alle löschen? (wird beim nächsten Teilen übertragen)')) return;
    await M.deleteFeature(poi.id);
    toast('POI gelöscht.');
  } else if (v === 'ok') {
    const p = poi ? await db.get('features', poi.id) : M.newFeature({ type: 'poi', kind: f.cat.value, mapId: null, coords: [ll] });
    Object.assign(p, { kind: f.cat.value, name: f.name.value.trim(), note: f.note.value.trim() });
    await M.saveFeature(p);
    toast(poi ? 'POI gespeichert.' : 'POI angelegt – geht beim nächsten „Stand teilen“ an die anderen.');
  } else return;
  S.pois = (await M.getFeatures()).filter((x) => x.type === 'poi');
  if ($('#view-overview').classList.contains('active')) ov.update();
  if (S.map) { $('#map-pop').innerHTML = ''; await reloadFeatures(); }
}

function drawPos() {
  gPos.selectAll('*').remove();
  if (!S.pos || !S.map) return;
  const [u, v] = toPx([S.pos.lat, S.pos.lon]);
  const [x, y] = S.zt.apply([u, v]);
  const r = (S.pos.acc / S.mPerPx) * S.zt.k;
  gPos.append('circle').attr('cx', x).attr('cy', y).attr('r', Math.max(r, 10)).attr('fill', '#2563eb22').attr('stroke', '#2563eb66');
  if (S.pos.heading != null && !isNaN(S.pos.heading) && (S.pos.speed ?? 0) > 0.5) {
    gPos.append('path').attr('d', 'M0,-26 L9,-8 L-9,-8 Z').attr('fill', '#2563eb')
      .attr('transform', `translate(${x},${y}) rotate(${S.pos.heading + (S.phi || 0)})`);
  }
  gPos.append('circle').attr('cx', x).attr('cy', y).attr('r', 9).attr('fill', '#2563eb').attr('stroke', '#fff').attr('stroke-width', 3);
}

function centerOnPos(animate, k) {
  if (!S.pos || !S.map) { toast('Noch keine GPS-Position.'); return; }
  const [u, v] = toPx([S.pos.lat, S.pos.lon]);
  const { width: W, height: H } = $('#stage').getBoundingClientRect();
  const kk = k ?? Math.max(S.zt.k, 0.8);
  const t = d3.zoomIdentity.translate(W / 2 - u * kk, H / 2 - v * kk).scale(kk);   // Drehung ist um die Mitte -> bleibt Mitte
  (animate ? gRot.transition().duration(400) : gRot).call(S.zoom.transform, t);
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
  updateUndo();
  if (!id) return;
  await removeWithRestore(id, 'Letzte Linie entfernt.');
}

function updateUndo() {
  $('#t-undo').disabled = !S.undo.length;
}

/** Linie/Track löschen, mit "Wiederherstellen" in der Meldung */
async function removeWithRestore(id, msg) {
  const before = await db.get('features', id);
  if (!before) return;
  await M.deleteFeature(id);
  await reloadFeatures();
  toast(msg, 7000, {
    label: 'Wiederherstellen',
    fn: async () => {
      await M.saveFeature({ ...before, deleted: false });
      if (before.author === M.settings.user && S.map) { S.undo.push(id); updateUndo(); }
      await reloadFeatures();
    },
  });
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
  updateUndo();
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
        history.back();
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
  $('#dlg-noshare').addEventListener('close', () => {
    if ($('#dlg-noshare').returnValue === 'download' && pendingDownload) downloadFiles(pendingDownload);
    pendingDownload = null;
  });
  const sf = $('#dlg-share form');
  sf.season.onchange = prepareShare;
  sf.withPdf.onchange = () => { $('#share-pdf-hint').hidden = !sf.withPdf.checked; prepareShare(); };
  sf.querySelector('button[value=ok]').addEventListener('click', (e) => {
    e.preventDefault();
    doShare();
  });

  // Einstellungen
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
  $('#stats-season').onchange = renderStats;
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
  // Tastatur nur öffnen, wenn noch kein Name eingetragen ist
  const noName = !M.settings.user;
  f.user.autofocus = noName;
  $('#dlg-settings h2').autofocus = !noName;
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
  $('#share-pdf-hint').hidden = true;
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
  // Mit Karten: alles in EINER Datei (ZIP lässt Chrome beim Teilen nicht zu)
  if (f.withPdf.checked) { btn.textContent = 'Karten werden eingepackt …'; await M.attachPdfs(data); }
  const name = `${data.pdfs ? 'Mulchpaket' : 'Mulchstand'}_${stamp}_${safeUser}.txt`;
  const files = [new File([JSON.stringify(data)], name, { type: 'text/plain' })];
  sharePrepared = { files, data };
  btn.disabled = false;
  const mb = files[0].size / 1e6;
  btn.textContent = `Teilen (${data.maps.length} Karten, ${data.features.filter((x) => !x.deleted).length} Linien` +
    `${data.pdfs ? `, mit ${data.pdfs.length} PDFs · ${mb.toFixed(mb < 10 ? 1 : 0).replace('.', ',')} MB` : ''})`;
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
function openTimesView() {
  const sel = $('#stats-season'), prev = sel.value;
  const seasons = [...new Set([M.settings.season, ...S.maps.map((m) => m.season).filter(Boolean)])].sort().reverse();
  $('#stats-season').innerHTML = seasons.map((s) => `<option>${esc(s)}</option>`).join('') + '<option value="alle">Alle</option>';
  $('#stats-season').value = prev && [...sel.options].some((o) => o.value === prev) ? prev : M.settings.season;
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
  $('#dlg-poi').addEventListener('close', onPoiClose);
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
  if (activeView() === 'view-times') renderStats();
}

init().catch((e) => { console.error(e); toast('Fehler beim Start: ' + e.message, 10000); });

// Für Tests
window.__mk = { S, M, handleFiles, openMap, checkZone };
