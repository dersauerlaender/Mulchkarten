// Geo-PDF importieren: Hash bilden, Georeferenz lesen, Seite als Bild rendern.
import * as pdfjs from '../vendor/pdf.min.mjs';
import { extractGeoref, fitAffine, bboxOf } from './georef.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const MAX_DIM = 4096;      // iOS-Canvas-Grenzen beachten
const MAX_AREA = 12e6;

export async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function nameFromFile(fileName) {
  return fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
}

/**
 * Liefert { id, georef, imgBlob, width, height } für eine PDF-Datei.
 */
export async function processPdf(file) {
  const buf = await file.arrayBuffer();
  const id = (await sha256Hex(buf)).slice(0, 20);

  // 1) Georeferenz mit pdf-lib
  const PDFLib = window.PDFLib;
  const doc = await PDFLib.PDFDocument.load(buf.slice(0), { updateMetadata: false, ignoreEncryption: true });
  const geo = extractGeoref(doc, PDFLib);

  // 2) Rendern mit pdf.js
  const task = pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) });
  const pdf = await task.promise;
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  let scale = Math.min(MAX_DIM / base.width, MAX_DIM / base.height);
  scale = Math.min(scale, Math.sqrt(MAX_AREA / (base.width * base.height)));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
  const imgBlob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
  const width = canvas.width, height = canvas.height;
  canvas.width = canvas.height = 1; // Speicher freigeben (iOS)
  await task.destroy();

  // 3) Pixel <-> lat/lon
  const px = geo.pagePts.map(([x, y]) => vp.convertToViewportPoint(x, y));
  const coef = fitAffine(px, geo.latlon);

  return {
    id,
    pdfBlob: new Blob([buf], { type: 'application/pdf' }),
    imgBlob,
    width,
    height,
    georef: { coef, footprint: geo.latlon, bbox: bboxOf(geo.latlon), wkt: geo.wkt },
  };
}
