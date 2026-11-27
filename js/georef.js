// Georeferenz aus Geo-PDFs lesen (ISO 32000 "Geospatial PDF", z. B. ArcGIS-Export)
// und Umrechnung Bildpixel <-> WGS84.

/**
 * Liest die Georeferenz der ersten Seite mit pdf-lib.
 * Liefert Viewport-BBox (PDF-Seitenkoordinaten), GPTS (lat/lon) und daraus
 * berechnete Seitenpunkte. Bei mehreren Viewports wird der größte genommen.
 */
export function extractGeoref(pdfDoc, PDFLib) {
  const { PDFName, PDFArray, PDFDict, PDFNumber } = PDFLib;
  const ctx = pdfDoc.context;
  const look = (v) => (v ? ctx.lookup(v) : undefined);
  const nums = (arr) => {
    arr = look(arr);
    if (!(arr instanceof PDFArray)) return null;
    return arr.asArray().map((x) => {
      x = look(x);
      return x instanceof PDFNumber ? x.asNumber() : Number(x?.toString());
    });
  };

  const page = pdfDoc.getPages()[0];
  const vps = look(page.node.get(PDFName.of('VP')));
  const candidates = [];
  if (vps instanceof PDFArray) {
    for (const v of vps.asArray()) {
      const vp = look(v);
      if (!(vp instanceof PDFDict)) continue;
      const measure = look(vp.get(PDFName.of('Measure')));
      if (!(measure instanceof PDFDict)) continue;
      const subtype = measure.get(PDFName.of('Subtype'))?.toString();
      if (subtype && subtype !== '/GEO') continue;
      const bbox = nums(vp.get(PDFName.of('BBox')));
      const gpts = nums(measure.get(PDFName.of('GPTS')));
      let lpts = nums(measure.get(PDFName.of('LPTS')));
      if (!bbox || !gpts || gpts.length < 6) continue;
      if (!lpts) lpts = [0, 0, 0, 1, 1, 1, 1, 0]; // Standardannahme laut Spezifikation
      const [x1, y1, x2, y2] = bbox;
      const latlon = [], pagePts = [];
      for (let i = 0; i + 1 < gpts.length && i + 1 < lpts.length; i += 2) {
        latlon.push([gpts[i], gpts[i + 1]]);
        pagePts.push([x1 + lpts[i] * (x2 - x1), y1 + lpts[i + 1] * (y2 - y1)]);
      }
      let wkt = '';
      const gcs = look(measure.get(PDFName.of('GCS')));
      if (gcs instanceof PDFDict) wkt = look(gcs.get(PDFName.of('WKT')))?.decodeText?.() ?? '';
      candidates.push({ bbox, latlon, pagePts, wkt, area: Math.abs((x2 - x1) * (y2 - y1)) });
    }
  }
  if (!candidates.length) {
    throw new Error('Keine Georeferenz gefunden. Die PDF ist vermutlich kein Geo-PDF (oder ein älteres TerraGo-Format).');
  }
  candidates.sort((a, b) => b.area - a.area);
  return candidates[0];
}

/** Löst ein 3x3-Gleichungssystem (Cramer). */
function solve3(M, b) {
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (Math.abs(D) < 1e-18) throw new Error('Georeferenz ist entartet.');
  return [0, 1, 2].map((c) => det(M.map((row, r) => row.map((v, k) => (k === c ? b[r] : v)))) / D);
}

/**
 * Affine Transformation Pixel (u,v) -> (lat,lon) per kleinste Quadrate.
 * Für Kartenausschnitte von wenigen km ist der Fehler gegenüber UTM vernachlässigbar.
 */
export function fitAffine(pixelPts, latlonPts) {
  const n = pixelPts.length;
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const bLat = [0, 0, 0], bLon = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const r = [pixelPts[i][0], pixelPts[i][1], 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) M[a][b] += r[a] * r[b];
      bLat[a] += r[a] * latlonPts[i][0];
      bLon[a] += r[a] * latlonPts[i][1];
    }
  }
  return { lat: solve3(M, bLat), lon: solve3(M, bLon) };
}

export function makeTransform(coef) {
  const [a, b, c] = coef.lat, [d, e, f] = coef.lon;
  const det = a * e - b * d;
  return {
    toLatLon: (u, v) => [a * u + b * v + c, d * u + e * v + f],
    toPixel: (lat, lon) => {
      const y1 = lat - c, y2 = lon - f;
      return [(e * y1 - b * y2) / det, (-d * y1 + a * y2) / det];
    },
  };
}

const R = 6371008.8;
const rad = (x) => (x * Math.PI) / 180;

export function distMeters([lat1, lon1], [lat2, lon2]) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Punkt-in-Polygon (Ray casting) auf lat/lon – für kleine Flächen ausreichend. */
export function inPolygon([lat, lon], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Abstand eines Punktes zum Polygonrand in Metern (lokale Ebene). 0 wenn innen. */
export function distToPolygon(p, poly) {
  if (inPolygon(p, poly)) return 0;
  const k = Math.cos(rad(p[0]));
  const toXY = ([la, lo]) => [rad(lo) * R * k, rad(la) * R];
  const P = toXY(p);
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const A = toXY(poly[i]), B = toXY(poly[(i + 1) % poly.length]);
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const t = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy));
  }
  return best;
}

export function bboxOf(pts) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [la, lo] of pts) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  return [s, w, n, e];
}

export function bboxOverlap(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function lineLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += distMeters(coords[i - 1], coords[i]);
  return d;
}
