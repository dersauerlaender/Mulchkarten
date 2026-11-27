// Datenmodell: Karten, Zeichnungen/Tracks, Import/Export des Arbeitsstands.
import { db } from './db.js';
import { processPdf, nameFromFile } from './pdfimport.js';
import { bboxOf, lineLength } from './georef.js';

export const FORMAT = 'mulchkarten-stand';
export const FORMAT_VERSION = 1;

export const now = () => new Date().toISOString();
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/** Saison läuft Juli bis Juni: Nov 2026 -> "26/27". */
export function seasonFor(d = new Date()) {
  const y = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  const yy = y % 100;
  return `${String(yy).padStart(2, '0')}/${String((yy + 1) % 100).padStart(2, '0')}`;
}

export const settings = {
  user: '',
  season: seasonFor(),
  async load() {
    this.user = await db.meta.get('user', '');
    this.season = await db.meta.get('season', seasonFor());
  },
  async save() {
    await db.meta.set('user', this.user);
    await db.meta.set('season', this.season);
  },
};

// ---------- Karten ----------
export const getMaps = () => db.getAll('maps');
export const getMap = (id) => db.get('maps', id);

export async function updateMap(id, patch) {
  const m = await getMap(id);
  if (!m) return;
  Object.assign(m, patch, { updatedAt: now(), updatedBy: settings.user });
  if (patch.status === 'fertig') { m.doneAt = now(); m.doneBy = settings.user; }
  await db.put('maps', m);
  return m;
}

export async function deleteMapLocal(id) {
  await db.del('maps', id);
  await db.del('blobs', id + ':img');
  await db.del('blobs', id + ':pdf');
  await db.del('blobs', id + ':thumb');
}

export const getImage = (id) => db.get('blobs', id + ':img');
export const getPdf = (id) => db.get('blobs', id + ':pdf');

/** Kleines Vorschaubild für die Übersichtskarte (wird bei Bedarf erzeugt). */
export async function getThumb(id) {
  let t = await db.get('blobs', id + ':thumb');
  if (t) return t;
  const img = await getImage(id);
  if (!img) return null;
  const bmp = await createImageBitmap(img);
  const k = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  t = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
  await db.put('blobs', t, id + ':thumb');
  return t;
}

/** Eine PDF importieren. Rückgabe: 'neu' | 'doppelt' | 'ergänzt' (Platzhalter gefüllt) */
export async function importPdfFile(file) {
  const r = await processPdf(file);
  const existing = await getMap(r.id);
  await db.put('blobs', r.imgBlob, r.id + ':img');
  await db.put('blobs', r.pdfBlob, r.id + ':pdf');
  if (existing?.hasPdf) return { result: 'doppelt', map: existing };
  const t = now();
  const base = existing || {
    id: r.id,
    name: nameFromFile(file.name || 'Karte'),
    season: settings.season,
    revier: '',
    note: '',
    status: 'offen',
    addedAt: t,
    updatedAt: t,   // gleich addedAt = "unbearbeitet" -> verliert beim Zusammenführen immer
    updatedBy: settings.user,
  };
  Object.assign(base, {
    fileName: file.name || base.fileName || '',
    hasPdf: true,
    width: r.width,
    height: r.height,
    georef: r.georef,
  });
  await db.put('maps', base);
  return { result: existing ? 'ergänzt' : 'neu', map: base };
}

// ---------- Zeichnungen & Tracks ----------
export async function getFeatures({ includeDeleted = false } = {}) {
  const all = await db.getAll('features');
  return includeDeleted ? all : all.filter((f) => !f.deleted);
}

export async function saveFeature(f) {
  f.updatedAt = now();
  f.bbox = f.coords?.length ? bboxOf(f.coords) : null;
  f.length = f.coords?.length ? Math.round(lineLength(f.coords)) : 0;
  await db.put('features', f);
  return f;
}

export function newFeature({ type, kind, mapId, coords, startedAt, endedAt }) {
  return {
    id: uid(), type, kind, mapId, coords,
    author: settings.user, createdAt: now(),
    startedAt: startedAt || null, endedAt: endedAt || null,
  };
}

export async function deleteFeature(id) {
  const f = await db.get('features', id);
  if (!f) return;
  f.deleted = true;
  f.coords = [];
  await saveFeature(f); // Grabstein, damit das Löschen beim Teilen ankommt
}

// ---------- Zeiterfassung ----------
export async function getTimes({ includeDeleted = false } = {}) {
  const all = await db.getAll('times');
  return includeDeleted ? all : all.filter((t) => !t.deleted);
}
export const getTime = (id) => db.get('times', id);

export async function saveTime(t) {
  t.updatedAt = now();
  await db.put('times', t);
  return t;
}

export function newTime({ mapId, start, end = null }) {
  return { id: uid(), mapId, start: start || now(), end, author: settings.user, createdAt: now() };
}

export async function deleteTime(id) {
  const t = await getTime(id);
  if (!t) return;
  t.deleted = true;
  await saveTime(t);
}

/** Laufender eigener Eintrag (end == null) */
export async function getRunningTime() {
  return (await getTimes()).find((t) => !t.end && t.author === settings.user) || null;
}

export function timeHours(t, until = new Date()) {
  const e = t.end ? new Date(t.end) : until;
  return Math.max(0, (e - new Date(t.start)) / 3.6e6);
}

// ---------- Export / Import ----------
export async function buildExport({ season = 'alle' } = {}) {
  let maps = await getMaps();
  if (season !== 'alle') maps = maps.filter((m) => m.season === season);
  const ids = new Set(maps.map((m) => m.id));
  // POIs gehören zu keiner Karte und gehen immer mit
  const features = (await getFeatures({ includeDeleted: true })).filter((f) => season === 'alle' || f.type === 'poi' || ids.has(f.mapId));
  const cleanMap = ({ id, name, fileName, season, revier, note, status, doneAt, doneBy, addedAt, updatedAt, updatedBy, width, height, georef }) =>
    ({ id, name, fileName, season, revier, note, status, doneAt, doneBy, addedAt, updatedAt, updatedBy, width, height, georef });
  // nur abgeschlossene Zeiteinträge teilen
  const times = (await getTimes({ includeDeleted: true })).filter((t) => t.end && (season === 'alle' || ids.has(t.mapId)));
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: now(),
    exportedBy: settings.user,
    season,
    maps: maps.map(cleanMap),
    features: features.map(({ bbox, ...f }) => f),
    times: times.map(({ lastInsideAt, ...t }) => t),
  };
}

const newer = (a, b) => (a?.updatedAt || '') > (b?.updatedAt || '');
/** Karte nur importiert, nie bearbeitet (Status, Revier, Name …) */
const isPristine = (m) => !!m?.addedAt && m.updatedAt === m.addedAt;

/** Führt einen fremden Stand zusammen. Neuere Änderung gewinnt (pro Karte, pro Linie). */
export async function mergeState(data) {
  if (data?.format !== FORMAT) throw new Error('Datei ist kein Mulchkarten-Arbeitsstand.');
  const stats = { mapsNew: 0, mapsUpd: 0, missingPdf: 0, featNew: 0, featUpd: 0, featDel: 0, timesNew: 0, timesUpd: 0 };
  for (const inc of data.maps || []) {
    const loc = await getMap(inc.id);
    if (!loc) {
      await db.put('maps', { ...inc, hasPdf: false });
      stats.mapsNew++; stats.missingPdf++;
    } else if ((newer(inc, loc) && !isPristine(inc)) || (isPristine(loc) && !isPristine(inc))) {
      const { width, height, georef, ...meta } = inc;
      await db.put('maps', { ...loc, ...meta });
      stats.mapsUpd++;
    }
  }
  for (const inc of data.features || []) {
    const loc = await db.get('features', inc.id);
    if (!loc || newer(inc, loc)) {
      const f = { ...inc, bbox: inc.coords?.length ? bboxOf(inc.coords) : null };
      await db.put('features', f);
      if (inc.deleted) { if (loc && !loc.deleted) stats.featDel++; }
      else if (loc) stats.featUpd++; else stats.featNew++;
    }
  }
  for (const inc of data.times || []) {
    const loc = await getTime(inc.id);
    if (!loc || newer(inc, loc)) {
      await db.put('times', inc);
      if (loc) stats.timesUpd++; else if (!inc.deleted) stats.timesNew++;
    }
  }
  return stats;
}

// ---------- Auswertung ----------
export function trackHours(f) {
  if (f.type !== 'track' || !f.startedAt || !f.endedAt) return 0;
  return Math.max(0, (new Date(f.endedAt) - new Date(f.startedAt)) / 3.6e6);
}
