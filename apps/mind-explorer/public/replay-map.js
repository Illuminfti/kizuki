/* Kizuki Mind Explorer - Private Offline Interactive Geo Map Canvas */
/* 100% offline/private Canvas2D Mercator vector renderer, zero external tile requests */
/* Pure ES2022, zero dependencies, DPR-aware, dark & light Vercel Geist polarity */

(function initKizukiReplayMapModule(global) {
  'use strict';

  const MAX_LAT = 82;
  const MIN_LAT = -82;
  const DEG_TO_RAD = Math.PI / 180;
  const RAD_TO_DEG = 180 / Math.PI;
  const EARTH_RADIUS_KM = 6371;
  const HOME_LAT = 51.4015;
  const HOME_LNG = -0.0757;
  const AWAY_THRESHOLD_KM = 30;
  const HIT_RADIUS_PX = 14;
  const CAMERA_TWEEN_MS = 260;
  const ARC_ANIM_MS = 340;
  const GEODESIC_SEGMENTS = 36;
  const COMET_SPEED_PX_S = 140;
  const COMET_TAIL_PX = 60;
  const COMET_REST_S = 1.2;
  const COMET_CORE_R = 4;
  const PIN_PULSE_PEAK_MS = 110;
  const PIN_PULSE_TOTAL_MS = 380;
  const MAP_HUD_STYLE_ID = 'kizuki-replay-map-craft-styles';

  function ensureReplayMapHudStyles() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById(MAP_HUD_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = MAP_HUD_STYLE_ID;
    style.textContent = [
      '#replay-map-hud {',
      '  border-color: rgba(212, 175, 110, 0.28);',
      '  background: linear-gradient(128deg, rgba(16, 22, 24, 0.90) 0%, rgba(12, 16, 20, 0.88) 54%, rgba(28, 25, 18, 0.88) 100%);',
      '  box-shadow: inset 0 1px 0 rgba(244, 220, 172, 0.22), inset 0 -1px 0 rgba(52, 211, 153, 0.14), 0 4px 16px rgba(0, 0, 0, 0.44);',
      '  color: var(--ink-primary, #ededed);',
      '}',
      '#replay-map-hud .replay-map-hud-dot.is-active-dot {',
      '  background-color: #34d399;',
      '  box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.24);',
      '}',
      '#replay-map-modes,',
      '#replay-map-controls {',
      '  border-color: rgba(212, 175, 110, 0.20);',
      '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 4px 14px rgba(0, 0, 0, 0.40);',
      '}',
      'html[data-theme="light"] #replay-map-hud {',
      '  border-color: rgba(15, 118, 110, 0.22);',
      '  background: linear-gradient(128deg, rgba(255, 255, 255, 0.96) 0%, rgba(246, 250, 248, 0.94) 60%, rgba(252, 249, 242, 0.94) 100%);',
      '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.95), 0 2px 10px rgba(15, 23, 42, 0.08);',
      '  color: var(--ink-primary, #171717);',
      '}',
      'html[data-theme="light"] #replay-map-modes,',
      'html[data-theme="light"] #replay-map-controls {',
      '  border-color: rgba(15, 23, 42, 0.14);',
      '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.92), 0 2px 8px rgba(15, 23, 42, 0.07);',
      '}',
      'html[data-detail="off"] #replay-map-hud,',
      'html[data-detail="off"] #replay-map-modes,',
      'html[data-detail="off"] #replay-map-controls,',
      'html[data-detail="off"] #replay-map-hud .replay-map-hud-dot {',
      '  box-shadow: none;',
      '  background-image: none;',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function nowMs() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function easeOutCubic(t) {
    const inv = 1 - clamp(t, 0, 1);
    return 1 - inv * inv * inv;
  }

  function getGeoAtlas() {
    if (typeof window !== 'undefined' && window && window.KizukiGeoAtlas) {
      return window.KizukiGeoAtlas;
    }
    if (global && global.KizukiGeoAtlas) {
      return global.KizukiGeoAtlas;
    }
    if (typeof globalThis !== 'undefined' && globalThis && globalThis.KizukiGeoAtlas) {
      return globalThis.KizukiGeoAtlas;
    }
    return null;
  }

  // De Casteljau subdivision for partial quadratic Bezier draw-in [0..t]
  function subQuadBezier(x0, y0, cx, cy, x1, y1, t) {
    const u = clamp(t, 0, 1);
    const qx = x0 + (cx - x0) * u;
    const qy = y0 + (cy - y0) * u;
    const rx = cx + (x1 - cx) * u;
    const ry = cy + (y1 - cy) * u;
    const ex = qx + (rx - qx) * u;
    const ey = qy + (ry - qy) * u;
    return { cpx: qx, cpy: qy, ex, ey };
  }

  // Region framing presets (all strictly within safe Mercator latitude bounds)
  const REGION_PRESETS = {
    uk: { minLat: 49.55, maxLat: 59.15, minLng: -8.6, maxLng: 2.3 },
    europe: { minLat: 35.5, maxLat: 60.5, minLng: -11.0, maxLng: 24.0 },
    world: { minLat: -50.0, maxLat: 68.0, minLng: -135.0, maxLng: 155.0 },
  };

  function clamp(val, min, max) {
    return val < min ? min : (val > max ? max : val);
  }

  function lngToMercX(lng) {
    const c = clamp(Number(lng) || 0, -180, 180);
    return (c + 180) / 360;
  }

  function latToMercY(lat) {
    const c = clamp(Number(lat) || 0, MIN_LAT, MAX_LAT);
    const rad = c * DEG_TO_RAD;
    return 0.5 - Math.log(Math.tan(Math.PI * 0.25 + rad * 0.5)) / (2 * Math.PI);
  }

  function mercXToLng(mx) {
    return mx * 360 - 180;
  }

  function mercYToLat(my) {
    const c = clamp(my, 0.001, 0.999);
    const n = Math.PI - 2 * Math.PI * c;
    return RAD_TO_DEG * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * DEG_TO_RAD;
    const dLng = (lng2 - lng1) * DEG_TO_RAD;
    const a =
      Math.sin(dLat * 0.5) * Math.sin(dLat * 0.5) +
      Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) *
      Math.sin(dLng * 0.5) * Math.sin(dLng * 0.5);
    return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    const radius = Math.min(r, w * 0.5, h * 0.5);
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function rectsOverlap(a, b) {
    return !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);
  }

  function truncateLabel(text, maxLen) {
    const s = String(text || '').trim();
    if (s.length <= maxLen) return s;
    const budget = Math.max(1, maxLen - 1);
    const head = s.slice(0, budget);
    if (s.charAt(budget) && !/[\s\/\-]/.test(s.charAt(budget))) {
      const match = head.match(/^(.*?)[\s\/\-]+[^\s\/\-]*$/);
      if (match && match[1].length >= Math.floor(budget * 0.45)) {
        return match[1].replace(/[\s,.;:\/\-]+$/, '') + '\u2026';
      }
    }
    return head.replace(/[\s,.;:\/\-]+$/, '') + '\u2026';
  }

  function formatCoordLabel(deg, latAxis) {
    const abs = Math.abs(deg);
    const hemi = latAxis ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
    if (abs < 0.0001) return '0\u00b0';
    if (Math.abs(abs - Math.round(abs)) < 1e-4) {
      return Math.round(abs) + '\u00b0' + hemi;
    }
    const fixed = abs < 1 ? abs.toFixed(2) : abs.toFixed(1);
    return fixed.replace(/\.0+$/, '') + '\u00b0' + hemi;
  }

  function pickGraticuleStep(spanDeg) {
    const steps = [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 45];
    const target = spanDeg / 5.2;
    for (let i = 0; i < steps.length; i += 1) {
      if (steps[i] >= target) return steps[i];
    }
    return 45;
  }

  // Great-circle interpolation between two [lat, lng] coordinates
  function sampleGreatCircle(lat1, lng1, lat2, lng2, segments) {
    const phi1 = lat1 * DEG_TO_RAD;
    const lam1 = lng1 * DEG_TO_RAD;
    const phi2 = lat2 * DEG_TO_RAD;
    const lam2 = lng2 * DEG_TO_RAD;

    const x1 = Math.cos(phi1) * Math.cos(lam1);
    const y1 = Math.cos(phi1) * Math.sin(lam1);
    const z1 = Math.sin(phi1);

    const x2 = Math.cos(phi2) * Math.cos(lam2);
    const y2 = Math.cos(phi2) * Math.sin(lam2);
    const z2 = Math.sin(phi2);

    const dot = clamp(x1 * x2 + y1 * y2 + z1 * z2, -1, 1);
    const omega = Math.acos(dot);
    const out = [];

    if (omega < 1e-5) {
      out.push([lng1, lat1], [lng2, lat2]);
      return out;
    }

    const sinOmega = Math.sin(omega);
    for (let i = 0; i <= segments; i += 1) {
      const t = i / segments;
      const a = Math.sin((1 - t) * omega) / sinOmega;
      const b = Math.sin(t * omega) / sinOmega;
      const x = a * x1 + b * x2;
      const y = a * y1 + b * y2;
      const z = a * z1 + b * z2;
      const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * RAD_TO_DEG;
      const lng = Math.atan2(y, x) * RAD_TO_DEG;
      out.push([lng, clamp(lat, MIN_LAT, MAX_LAT)]);
    }
    return out;
  }

  // =========================================================================
  // EMBEDDED OFFLINE VECTOR GEOGRAPHY ([lng, lat] WGS84 polygons & polylines)
  // Zero network calls, high-craft UK & Europe detail, crisp world silhouettes
  // =========================================================================

  const LAND_POLYGONS = [
    // Great Britain (Mainland, high-detail coastline for UK & London zoom)
    [
      [-5.71, 50.07], [-5.20, 49.96], [-4.95, 50.15], [-4.50, 50.33],
      [-4.14, 50.37], [-3.65, 50.22], [-3.50, 50.45], [-3.10, 50.69],
      [-2.45, 50.52], [-1.95, 50.62], [-1.60, 50.74], [-1.09, 50.79],
      [-0.78, 50.73], [-0.36, 50.81], [-0.14, 50.82], [0.25, 50.74],
      [0.58, 50.85], [0.97, 50.91], [1.31, 51.13], [1.44, 51.38],
      [1.05, 51.37], [0.68, 51.44], [0.35, 51.47], [0.18, 51.49],
      [0.48, 51.51], [0.85, 51.54], [0.96, 51.68], [1.29, 51.94],
      [1.62, 52.16], [1.75, 52.48], [1.68, 52.73], [1.30, 52.93],
      [0.60, 52.96], [0.36, 52.84], [0.06, 52.93], [0.34, 53.15],
      [0.24, 53.40], [-0.08, 53.57], [-0.28, 53.71], [0.12, 53.65],
      [-0.08, 54.11], [-0.40, 54.28], [-0.62, 54.49], [-1.15, 54.62],
      [-1.36, 54.90], [-1.42, 55.02], [-1.58, 55.38], [-1.78, 55.62],
      [-2.00, 55.77], [-2.35, 55.98], [-2.75, 56.05], [-3.30, 56.00],
      [-2.75, 56.18], [-2.60, 56.28], [-2.82, 56.45], [-2.46, 56.71],
      [-2.08, 57.15], [-1.78, 57.51], [-2.12, 57.69], [-3.10, 57.71],
      [-3.70, 57.62], [-4.12, 57.56], [-3.82, 57.82], [-3.30, 58.18],
      [-3.07, 58.64], [-3.75, 58.58], [-4.45, 58.53], [-5.00, 58.62],
      [-5.25, 58.25], [-5.75, 57.80], [-5.88, 57.35], [-6.22, 56.73],
      [-5.65, 56.35], [-5.68, 55.75], [-5.65, 55.30], [-5.40, 55.55],
      [-5.10, 55.92], [-4.82, 55.72], [-4.68, 55.35], [-5.05, 55.00],
      [-4.96, 54.64], [-4.40, 54.82], [-3.75, 54.85], [-3.25, 54.96],
      [-3.62, 54.52], [-3.35, 54.12], [-2.95, 54.02], [-3.05, 53.72],
      [-3.15, 53.40], [-3.40, 53.35], [-3.85, 53.32], [-4.22, 53.20],
      [-4.75, 52.80], [-4.20, 52.88], [-4.05, 52.42], [-4.65, 52.10],
      [-5.30, 51.88], [-5.12, 51.63], [-4.62, 51.67], [-4.30, 51.56],
      [-3.85, 51.60], [-3.45, 51.40], [-3.15, 51.45], [-2.68, 51.58],
      [-2.74, 51.45], [-3.04, 51.33], [-3.50, 51.22], [-4.23, 51.20],
      [-4.53, 51.02], [-4.55, 50.83], [-5.08, 50.42], [-5.48, 50.21],
    ],
    // Isle of Wight
    [
      [-1.58, 50.66], [-1.32, 50.76], [-1.07, 50.68], [-1.28, 50.58],
    ],
    // Anglesey
    [
      [-4.65, 53.31], [-4.32, 53.42], [-4.08, 53.30], [-4.38, 53.15],
    ],
    // Isle of Man
    [
      [-4.75, 54.08], [-4.58, 54.36], [-4.36, 54.41], [-4.33, 54.23], [-4.62, 54.05],
    ],
    // Outer Hebrides / Skye silhouette
    [
      [-6.78, 57.45], [-6.32, 57.68], [-5.88, 57.32], [-6.35, 57.08],
    ],
    [
      [-7.12, 58.10], [-6.25, 58.50], [-6.12, 58.18], [-6.80, 57.76],
    ],
    // Orkney
    [
      [-3.32, 59.02], [-2.78, 59.12], [-2.70, 58.85], [-3.22, 58.82],
    ],
    // Ireland (Republic + Northern Ireland)
    [
      [-9.50, 51.46], [-8.55, 51.62], [-7.55, 52.08], [-6.34, 52.18],
      [-6.02, 52.98], [-6.15, 53.42], [-6.18, 54.02], [-5.45, 54.45],
      [-5.65, 54.82], [-6.10, 55.22], [-7.05, 55.28], [-7.65, 55.38],
      [-8.40, 55.02], [-8.65, 54.62], [-8.50, 54.30], [-9.40, 54.32],
      [-10.05, 54.15], [-10.00, 53.65], [-10.15, 53.45], [-9.25, 53.22],
      [-9.50, 52.85], [-9.92, 52.56], [-10.48, 52.12], [-10.22, 51.72],
    ],
    // Iceland
    [
      [-24.2, 65.5], [-22.6, 66.4], [-18.5, 66.1], [-14.5, 66.2],
      [-13.5, 65.1], [-15.2, 64.2], [-18.8, 63.4], [-22.7, 63.8], [-24.0, 64.8],
    ],
    // Continental Europe & Eurasia West (Iberia, France, Benelux, Germany, Italy, Balkans, Greece, Turkey, Baltic, Russia West)
    [
      [-9.30, 38.70], [-8.95, 37.02], [-7.40, 37.18], [-6.25, 36.50],
      [-5.60, 36.01], [-4.42, 36.70], [-2.45, 36.82], [-0.50, 38.34],
      [-0.35, 39.46], [0.85, 40.72], [2.18, 41.38], [3.20, 42.32],
      [3.05, 43.25], [4.85, 43.35], [5.38, 43.29], [7.26, 43.70],
      [8.92, 44.40], [10.30, 43.55], [12.15, 41.78], [14.25, 40.84],
      [15.65, 38.10], [16.65, 38.80], [17.20, 40.35], [18.50, 40.15],
      [16.20, 41.90], [13.85, 43.45], [12.35, 45.44], [13.75, 45.65],
      [13.60, 44.85], [15.40, 44.05], [18.10, 42.65], [19.45, 40.50],
      [20.70, 39.00], [22.45, 36.40], [24.05, 37.90], [23.00, 40.60],
      [26.15, 40.85], [29.05, 41.10], [27.95, 42.65], [29.70, 45.25],
      [33.50, 46.20], [36.55, 45.20], [41.55, 41.65], [37.50, 41.05],
      [32.50, 41.80], [28.95, 41.02], [26.20, 39.85], [27.30, 37.05],
      [30.70, 36.85], [35.50, 36.60], [36.10, 35.80], [35.50, 33.85],
      [34.50, 31.30], [32.50, 31.25], [33.80, 27.80], [35.20, 29.50],
      [39.20, 21.50], [43.30, 12.65], [51.20, 15.60], [59.80, 22.50],
      [56.40, 26.25], [55.25, 25.25], [52.60, 24.10], [50.80, 25.30],
      [48.50, 29.85], [51.50, 28.00], [56.30, 27.10], [61.50, 25.20],
      [67.00, 24.85], [72.80, 19.00], [77.55, 8.08], [80.25, 13.08],
      [85.80, 20.10], [89.00, 22.00], [92.20, 20.80], [96.50, 16.40],
      [98.60, 10.20], [100.30, 5.40], [103.85, 1.30], [103.40, 4.50],
      [100.60, 13.50], [105.00, 8.70], [109.20, 12.80], [106.70, 20.80],
      [114.20, 22.30], [120.50, 27.50], [121.90, 31.20], [119.50, 35.00],
      [122.40, 37.40], [117.80, 39.00], [121.60, 39.00], [124.40, 40.00],
      [126.50, 34.70], [129.10, 35.15], [129.80, 42.30], [135.50, 44.50],
      [141.00, 53.00], [139.00, 57.50], [150.50, 59.50], [162.50, 59.80],
      [156.80, 51.00], [163.00, 56.50], [174.00, 62.50], [178.00, 66.50],
      [168.00, 69.50], [142.00, 72.50], [112.00, 74.00], [86.00, 73.50],
      [68.00, 70.50], [52.00, 68.50], [41.00, 67.00], [37.00, 64.50],
      [31.00, 69.80], [25.80, 71.10], [18.50, 69.70], [13.50, 66.80],
      [8.50, 63.40], [5.00, 61.50], [5.30, 59.00], [8.00, 58.05],
      [10.75, 59.85], [11.95, 57.70], [13.00, 55.45], [16.50, 56.80],
      [18.80, 59.35], [17.60, 61.80], [21.50, 64.75], [24.80, 65.80],
      [21.40, 61.50], [22.80, 59.85], [27.50, 60.40], [29.80, 60.00],
      [24.75, 59.45], [23.60, 57.75], [21.05, 56.50], [20.50, 54.90],
      [18.65, 54.40], [14.40, 53.95], [11.00, 54.15], [9.95, 54.80],
      [10.75, 56.20], [10.60, 57.74], [8.55, 57.10], [8.15, 55.55],
      [8.70, 53.88], [6.80, 53.45], [4.75, 52.95], [4.10, 51.95],
      [3.15, 51.34], [1.85, 50.96], [1.58, 50.55], [0.12, 49.49],
      [-1.70, 49.70], [-1.95, 48.65], [-4.75, 48.40], [-4.15, 47.78],
      [-2.15, 47.18], [-1.25, 45.80], [-1.45, 43.55], [-4.80, 43.45],
      [-8.35, 43.65], [-9.28, 42.90], [-8.85, 41.80], [-8.75, 40.60],
    ],
    // Corsica & Sardinia & Sicily
    [
      [8.60, 42.55], [9.45, 42.95], [9.45, 41.45], [8.70, 41.65],
    ],
    [
      [8.20, 40.95], [9.70, 41.15], [9.65, 39.15], [8.35, 39.00],
    ],
    [
      [12.45, 37.90], [15.65, 38.25], [15.10, 36.68], [12.50, 37.50],
    ],
    // Zealand (Denmark)
    [
      [11.10, 55.75], [12.58, 56.05], [12.60, 55.45], [11.45, 55.20],
    ],
    // Crete
    [
      [23.55, 35.50], [26.25, 35.25], [25.80, 34.95], [23.60, 35.22],
    ],
    // Cyprus
    [
      [32.30, 35.05], [34.55, 35.65], [34.05, 34.95], [32.45, 34.70],
    ],
    // Japan (Honshu + Hokkaido + Kyushu)
    [
      [130.9, 34.0], [134.8, 34.6], [137.0, 34.7], [139.8, 35.5],
      [140.9, 36.5], [141.9, 39.6], [141.3, 41.3], [139.9, 40.0],
      [138.8, 37.8], [136.6, 36.9], [133.5, 35.5],
    ],
    [
      [140.2, 41.8], [141.7, 45.4], [145.6, 43.3], [143.2, 42.0], [141.0, 42.3],
    ],
    [
      [129.8, 33.4], [131.6, 33.8], [131.5, 31.3], [130.1, 31.4],
    ],
    // Sri Lanka
    [
      [79.8, 9.7], [81.8, 7.5], [80.6, 5.9], [79.8, 7.2],
    ],
    // Taiwan
    [
      [120.2, 22.6], [121.6, 25.2], [121.9, 24.4], [120.9, 21.9],
    ],
    // Philippines (Luzon + Mindanao)
    [
      [119.9, 14.5], [120.8, 18.4], [122.4, 18.2], [122.5, 14.2], [123.8, 13.0], [121.1, 13.7],
    ],
    [
      [122.1, 7.0], [125.4, 9.6], [126.5, 7.3], [124.2, 6.2],
    ],
    // Indonesia (Sumatra, Java, Borneo, Sulawesi)
    [
      [95.3, 5.5], [99.6, 3.3], [105.8, -5.8], [103.5, -5.5], [97.4, 1.8],
    ],
    [
      [105.5, -6.2], [114.4, -7.8], [114.2, -8.7], [106.2, -7.2],
    ],
    [
      [109.1, 1.5], [115.3, 5.2], [118.8, 5.0], [117.6, -1.2],
      [116.0, -3.9], [110.3, -3.2],
    ],
    // Africa
    [
      [-17.4, 14.7], [-16.0, 21.2], [-13.2, 27.8], [-9.6, 30.4],
      [-5.8, 35.8], [3.1, 36.8], [10.8, 37.1], [11.5, 33.2],
      [15.2, 32.3], [20.1, 32.8], [25.2, 31.6], [32.3, 31.2],
      [34.8, 25.5], [37.5, 20.0], [43.2, 11.7], [51.3, 11.8],
      [48.5, 5.2], [41.5, -1.5], [39.5, -6.8], [40.5, -11.0],
      [40.6, -15.5], [35.0, -19.8], [32.8, -26.0], [28.0, -33.0],
      [20.0, -34.8], [18.4, -34.0], [15.0, -26.0], [12.0, -17.5],
      [13.1, -8.8], [9.4, -1.0], [9.2, 4.0], [3.4, 6.4],
      [-4.0, 5.2], [-7.6, 4.4], [-13.2, 8.5], [-16.5, 12.5],
    ],
    // Madagascar
    [
      [43.8, -24.8], [44.5, -19.5], [49.3, -12.0], [50.4, -15.4],
      [47.5, -24.9], [45.0, -25.5],
    ],
    // North America (Mainland with clear Florida/Miami, US East & West coasts, Gulf, Mexico, Canada, Alaska)
    [
      [-166.0, 60.0], [-165.5, 66.0], [-156.5, 71.3], [-141.0, 69.6],
      [-128.0, 70.0], [-110.0, 68.5], [-95.0, 68.0], [-82.0, 66.5],
      [-94.0, 60.5], [-88.0, 56.5], [-80.0, 52.0], [-78.0, 58.0],
      [-74.0, 62.2], [-64.5, 60.2], [-55.8, 52.0], [-61.0, 50.2],
      [-66.5, 49.0], [-64.2, 46.5], [-60.5, 46.0], [-66.0, 43.8],
      [-67.0, 44.9], [-70.2, 43.6], [-70.0, 41.7], [-73.9, 40.6],
      [-75.5, 38.0], [-75.5, 35.2], [-78.8, 33.7], [-81.2, 31.0],
      [-80.2, 26.8], [-80.28, 25.55], [-81.1, 25.15], [-82.6, 27.6],
      [-83.8, 30.0], [-87.5, 30.3], [-90.0, 29.1], [-94.8, 29.3],
      [-97.2, 26.0], [-97.8, 22.2], [-96.0, 19.2], [-91.0, 18.6],
      [-90.3, 21.1], [-86.8, 21.3], [-88.2, 16.0], [-83.5, 15.0],
      [-83.5, 10.2], [-79.5, 9.0], [-78.0, 8.2], [-80.5, 7.6],
      [-85.5, 10.5], [-92.2, 14.5], [-100.0, 16.8], [-105.5, 20.5],
      [-109.2, 25.5], [-114.5, 31.6], [-110.0, 23.0], [-112.0, 26.0],
      [-117.1, 32.5], [-120.5, 34.6], [-122.5, 37.8], [-124.5, 40.5],
      [-124.1, 46.2], [-124.7, 48.4], [-128.0, 51.0], [-133.0, 54.5],
      [-139.0, 59.5], [-147.0, 60.5], [-152.0, 58.8], [-161.0, 55.5],
    ],
    // Greenland
    [
      [-44.0, 60.0], [-52.5, 64.5], [-56.0, 72.5], [-70.0, 77.5],
      [-52.0, 81.5], [-20.0, 81.2], [-17.5, 74.0], [-22.0, 70.0],
      [-37.5, 65.5],
    ],
    // Newfoundland
    [
      [-59.2, 47.6], [-55.8, 51.5], [-52.7, 47.5], [-55.5, 46.8],
    ],
    // Cuba
    [
      [-84.9, 21.9], [-82.3, 23.1], [-78.0, 22.1], [-74.2, 20.2],
      [-77.6, 19.9], [-81.2, 22.1],
    ],
    // South America
    [
      [-78.0, 8.2], [-75.5, 10.5], [-71.5, 12.1], [-62.0, 10.4],
      [-52.0, 4.5], [-49.0, 0.0], [-41.5, -2.8], [-35.2, -5.8],
      [-34.8, -8.2], [-38.5, -13.0], [-40.8, -21.8], [-43.2, -23.0],
      [-48.5, -26.5], [-53.5, -33.8], [-57.5, -38.5], [-64.5, -42.5],
      [-67.5, -49.5], [-68.5, -54.8], [-73.5, -53.5], [-74.5, -45.5],
      [-73.2, -37.0], [-71.5, -30.0], [-70.5, -18.5], [-76.5, -13.8],
      [-81.3, -4.8], [-79.9, -2.0], [-78.8, 1.5], [-77.5, 5.5],
    ],
    // Australia
    [
      [113.5, -22.2], [122.2, -17.9], [129.0, -14.8], [131.0, -12.4],
      [136.8, -12.3], [136.0, -15.5], [140.8, -17.5], [142.5, -10.8],
      [145.5, -15.5], [150.5, -22.5], [153.6, -28.2], [151.2, -33.9],
      [149.9, -37.5], [145.0, -38.4], [140.0, -37.5], [136.5, -34.8],
      [131.0, -31.7], [124.0, -33.8], [115.1, -34.3], [115.7, -32.0],
      [113.6, -26.0],
    ],
    // Tasmania
    [
      [144.8, -40.7], [148.3, -41.0], [147.8, -43.2], [145.5, -43.3],
    ],
    // New Zealand (North & South Isles)
    [
      [172.7, -34.4], [178.5, -37.7], [175.3, -41.5], [173.8, -39.2],
    ],
    [
      [172.8, -40.8], [174.3, -41.7], [170.5, -46.2], [166.5, -46.1], [170.0, -43.1],
    ],
  ];

  // Subtle internal country borders (Europe & Alps context + UK internal)
  const COUNTRY_BORDERS = [
    // Germany - Austria Alpine border (runs just south of Garmisch-Partenkirchen & Grainau)
    [
      [9.55, 47.55], [10.18, 47.30], [10.58, 47.54], [10.98, 47.41],
      [11.30, 47.42], [11.88, 47.60], [12.40, 47.66], [12.98, 47.78],
      [13.45, 48.55], [13.84, 48.77],
    ],
    // Switzerland outline (connects France, Germany, Austria, Italy in Alps)
    [
      [6.02, 46.20], [6.65, 46.90], [7.55, 47.56], [8.55, 47.69],
      [9.55, 47.55], [9.53, 47.08], [10.45, 46.86], [10.45, 46.54],
      [9.40, 46.38], [8.98, 45.85], [7.80, 45.95], [6.88, 45.92], [6.02, 46.20],
    ],
    // Austria - Italy & Austria - Czech/Hungary rough border
    [
      [10.45, 46.86], [11.50, 47.00], [12.40, 46.72], [13.71, 46.52],
      [15.80, 46.70], [16.95, 47.70], [16.95, 48.65], [13.84, 48.77],
    ],
    // France - Germany - Belgium - Netherlands
    [
      [7.55, 47.56], [8.20, 48.98], [6.36, 49.47], [6.15, 50.15],
      [6.02, 50.76], [6.18, 51.84], [7.20, 53.25],
    ],
    // France - Belgium & France - Italy & France - Spain (Pyrenees)
    [
      [2.54, 51.09], [4.25, 50.25], [5.82, 49.55], [6.36, 49.47],
    ],
    [
      [6.88, 45.92], [6.70, 45.10], [7.50, 43.78],
    ],
    [
      [-1.78, 43.36], [0.15, 42.68], [1.72, 42.50], [3.16, 42.44],
    ],
    // Spain - Portugal
    [
      [-8.85, 41.88], [-6.25, 41.55], [-6.95, 39.65], [-7.40, 37.18],
    ],
    // Germany - Poland & Germany - Czechia
    [
      [14.22, 53.90], [14.70, 52.35], [14.82, 50.87], [12.10, 50.32], [13.84, 48.77],
    ],
    // England - Scotland subtle border
    [
      [-3.15, 54.99], [-2.55, 55.26], [-2.00, 55.77],
    ],
  ];

  // London close-up vector features: River Thames & M25 orbital ring
  const THAMES_RIVER = [
    [-0.44, 51.40], [-0.39, 51.39], [-0.34, 51.402], [-0.308, 51.412],
    [-0.312, 51.444], [-0.306, 51.460], [-0.292, 51.484], [-0.255, 51.486],
    [-0.228, 51.489], [-0.214, 51.467], [-0.193, 51.463], [-0.165, 51.481],
    [-0.148, 51.485], [-0.127, 51.486], [-0.122, 51.501], [-0.115, 51.509],
    [-0.104, 51.511], [-0.088, 51.508], [-0.075, 51.505], [-0.052, 51.504],
    [-0.036, 51.505], [-0.025, 51.486], [-0.008, 51.484], [0.006, 51.503],
    [0.032, 51.498], [0.068, 51.495], [0.132, 51.511], [0.184, 51.484],
    [0.258, 51.465], [0.355, 51.456], [0.460, 51.468], [0.620, 51.498],
  ];

  const LONDON_M25_RING = [
    [0.255, 51.462], [0.178, 51.390], [0.135, 51.285], [-0.010, 51.262],
    [-0.198, 51.258], [-0.342, 51.308], [-0.462, 51.320], [-0.530, 51.388],
    [-0.514, 51.472], [-0.500, 51.568], [-0.482, 51.640], [-0.402, 51.692],
    [-0.220, 51.694], [-0.155, 51.688], [-0.020, 51.689], [0.098, 51.678],
    [0.258, 51.608], [0.280, 51.530], [0.270, 51.484], [0.255, 51.462],
  ];

  // Subtle close-up London anchor labels (only visible when spanLon < 1.2)
  const LONDON_ANCHORS = [
    { label: 'Central London', lng: -0.1278, lat: 51.5074 },
    { label: 'Olympia', lng: -0.2115, lat: 51.4962 },
    { label: 'Croydon', lng: -0.0982, lat: 51.3762 },
    { label: 'Heathrow', lng: -0.4543, lat: 51.4700 },
    { label: 'Canary Wharf', lng: -0.0235, lat: 51.5054 },
    { label: 'Shoreditch', lng: -0.0754, lat: 51.5245 },
    { label: 'Gatwick', lng: -0.1821, lat: 51.1537 },
  ];

  // Subtle regional context labels shown at appropriate zoom bands
  const CONTEXT_LABELS = [
    // UK zoom band (1.2 <= spanLon <= 18)
    { label: 'LONDON', lng: -0.1278, lat: 51.5074, minSpan: 1.2, maxSpan: 55 },
    { label: 'BRIGHTON', lng: -0.1372, lat: 50.8225, minSpan: 1.4, maxSpan: 14 },
    { label: 'OXFORD', lng: -1.2577, lat: 51.7520, minSpan: 1.4, maxSpan: 14 },
    { label: 'BRISTOL', lng: -2.5879, lat: 51.4545, minSpan: 1.8, maxSpan: 16 },
    { label: 'CORNWALL', lng: -5.0800, lat: 50.4100, minSpan: 1.8, maxSpan: 18 },
    { label: 'MANCHESTER', lng: -2.2426, lat: 53.4808, minSpan: 2.4, maxSpan: 18 },
    { label: 'EDINBURGH', lng: -3.1883, lat: 55.9533, minSpan: 2.8, maxSpan: 20 },
    { label: 'DUBLIN', lng: -6.2603, lat: 53.3498, minSpan: 3.0, maxSpan: 22 },
    // Europe zoom band
    { label: 'UK', lng: -2.4000, lat: 54.6000, minSpan: 14.0, maxSpan: 75 },
    { label: 'PARIS', lng: 2.3522, lat: 48.8566, minSpan: 6.0, maxSpan: 65 },
    { label: 'AMSTERDAM', lng: 4.9041, lat: 52.3676, minSpan: 6.0, maxSpan: 48 },
    { label: 'BARCELONA', lng: 2.1734, lat: 41.3874, minSpan: 8.0, maxSpan: 65 },
    { label: 'ALPS', lng: 10.6000, lat: 47.0500, minSpan: 0.6, maxSpan: 48 },
    { label: 'BAVARIA', lng: 10.8500, lat: 47.7800, minSpan: 0.4, maxSpan: 7.5 },
    { label: 'TYROL', lng: 11.3800, lat: 47.2400, minSpan: 0.4, maxSpan: 7.5 },
    { label: 'AUSTRIA', lng: 13.6500, lat: 47.5500, minSpan: 2.2, maxSpan: 26 },
    { label: 'SWITZERLAND', lng: 8.2000, lat: 46.8000, minSpan: 2.2, maxSpan: 24 },
    { label: 'MUNICH', lng: 11.5820, lat: 48.1351, minSpan: 1.5, maxSpan: 38 },
    { label: 'ROME', lng: 12.4964, lat: 41.9028, minSpan: 14.0, maxSpan: 70 },
    // World zoom band
    { label: 'MIAMI', lng: -80.2870, lat: 25.7959, minSpan: 25.0, maxSpan: 400 },
    { label: 'NEW YORK', lng: -74.0060, lat: 40.7128, minSpan: 35.0, maxSpan: 400 },
    { label: 'DUBAI', lng: 55.2708, lat: 25.2048, minSpan: 35.0, maxSpan: 400 },
    { label: 'TOKYO', lng: 139.6503, lat: 35.6762, minSpan: 60.0, maxSpan: 400 },
  ];

  // Pre-project static vector layers once at module load for ultra-fast rendering
  function projectRing(coords) {
    return coords.map((pt) => [lngToMercX(pt[0]), latToMercY(pt[1])]);
  }

  const PROJECTED_LAND = LAND_POLYGONS.map(projectRing);
  const PROJECTED_BORDERS = COUNTRY_BORDERS.map(projectRing);
  const PROJECTED_THAMES = projectRing(THAMES_RIVER);
  const PROJECTED_M25 = projectRing(LONDON_M25_RING);
  const PROJECTED_LONDON_ANCHORS = LONDON_ANCHORS.map((a) => ({
    label: a.label,
    mx: lngToMercX(a.lng),
    my: latToMercY(a.lat),
  }));
  const PROJECTED_CONTEXT_LABELS = CONTEXT_LABELS.map((c) => ({
    label: c.label,
    mx: lngToMercX(c.lng),
    my: latToMercY(c.lat),
    minSpan: c.minSpan,
    maxSpan: c.maxSpan,
  }));

  function resolvePalette() {
    const docEl =
      typeof document !== 'undefined' && document && document.documentElement
        ? document.documentElement
        : null;
    const isLight = Boolean(
      docEl && (
        (docEl.dataset && docEl.dataset.theme === 'light') ||
        (typeof docEl.getAttribute === 'function' && docEl.getAttribute('data-theme') === 'light')
      )
    );

    let fontSans = "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
    let fontMono = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    try {
      if (docEl && typeof getComputedStyle === 'function') {
        const style = getComputedStyle(docEl);
        const fs = style.getPropertyValue('--font-sans').trim();
        const fm = style.getPropertyValue('--font-mono').trim();
        if (fs) fontSans = fs;
        if (fm) fontMono = fm;
      }
    } catch (_err) {
      // Fallback to defaults if computed style is unavailable
    }

    if (isLight) {
      return {
        isLight: true,
        fontSans,
        fontMono,
        ocean: '#f4f6f9',
        landFill: '#ffffff',
        landStroke: 'rgba(23, 23, 23, 0.16)',
        borderStroke: 'rgba(23, 23, 23, 0.085)',
        graticule: 'rgba(15, 23, 42, 0.075)',
        graticuleText: 'rgba(15, 23, 42, 0.52)',
        thamesStroke: 'rgba(0, 112, 243, 0.28)',
        thamesHighlight: 'rgba(0, 112, 243, 0.14)',
        m25Stroke: 'rgba(23, 23, 23, 0.12)',
        contextLabel: 'rgba(23, 23, 23, 0.32)',
        londonAnchorDot: 'rgba(23, 23, 23, 0.24)',
        londonAnchorText: 'rgba(23, 23, 23, 0.44)',
        activePin: '#16a34a',
        activePinGlow: 'rgba(22, 163, 74, 0.18)',
        activePinRing: 'rgba(22, 163, 74, 0.48)',
        activePinCore: '#ffffff',
        activePinSpec: 'rgba(255, 255, 255, 0.72)',
        activeArc: 'rgba(22, 163, 74, 0.86)',
        activeArcGlow: 'rgba(22, 163, 74, 0.18)',
        archivePin: '#0070f3',
        archivePinFill: 'rgba(0, 112, 243, 0.28)',
        archivePinStroke: 'rgba(0, 112, 243, 0.76)',
        archiveArc: 'rgba(0, 112, 243, 0.30)',
        archiveArcGlow: 'rgba(0, 112, 243, 0.09)',
        tripPin: '#d97706',
        tripPinFill: 'rgba(217, 119, 6, 0.28)',
        tripPinStroke: 'rgba(217, 119, 6, 0.88)',
        tripArc: 'rgba(217, 119, 6, 0.48)',
        tripArcGlow: 'rgba(217, 119, 6, 0.14)',
        clusterArchiveBg: '#0070f3',
        clusterArchiveStroke: '#ffffff',
        clusterTripBg: '#d97706',
        clusterTripStroke: '#ffffff',
        clusterText: '#ffffff',
        hoverRing: 'rgba(23, 23, 23, 0.88)',
        pillBg: 'rgba(255, 255, 255, 0.94)',
        pillBorder: 'rgba(23, 23, 23, 0.15)',
        pillText: '#171717',
        pillSubText: '#525252',
        scaleBarLine: 'rgba(23, 23, 23, 0.38)',
        scaleBarText: 'rgba(23, 23, 23, 0.56)',
        emptyText: 'rgba(23, 23, 23, 0.44)',
      };
    }

    return {
      isLight: false,
      fontSans,
      fontMono,
      ocean: '#050608',
      landFill: '#12151b',
      landStroke: 'rgba(255, 255, 255, 0.16)',
      borderStroke: 'rgba(255, 255, 255, 0.11)',
      graticule: 'rgba(203, 219, 240, 0.08)',
      graticuleText: 'rgba(214, 228, 246, 0.56)',
      thamesStroke: 'rgba(66, 158, 255, 0.30)',
      thamesHighlight: 'rgba(136, 214, 255, 0.16)',
      m25Stroke: 'rgba(255, 255, 255, 0.115)',
      contextLabel: 'rgba(255, 255, 255, 0.34)',
      londonAnchorDot: 'rgba(255, 255, 255, 0.24)',
      londonAnchorText: 'rgba(255, 255, 255, 0.38)',
      activePin: '#46a758',
      activePinGlow: 'rgba(70, 167, 88, 0.22)',
      activePinRing: 'rgba(70, 167, 88, 0.56)',
      activePinCore: '#050608',
      activePinSpec: 'rgba(255, 255, 255, 0.64)',
      activeArc: 'rgba(70, 167, 88, 0.90)',
      activeArcGlow: 'rgba(70, 167, 88, 0.22)',
      archivePin: '#3291ff',
      archivePinFill: 'rgba(50, 145, 255, 0.30)',
      archivePinStroke: 'rgba(50, 145, 255, 0.80)',
      archiveArc: 'rgba(50, 145, 255, 0.30)',
      archiveArcGlow: 'rgba(50, 145, 255, 0.10)',
      tripPin: '#f5a623',
      tripPinFill: 'rgba(245, 166, 35, 0.28)',
      tripPinStroke: 'rgba(245, 166, 35, 0.90)',
      tripArc: 'rgba(245, 166, 35, 0.46)',
      tripArcGlow: 'rgba(245, 166, 35, 0.15)',
      clusterArchiveBg: 'rgba(24, 72, 134, 0.94)',
      clusterArchiveStroke: '#3291ff',
      clusterTripBg: 'rgba(138, 84, 12, 0.94)',
      clusterTripStroke: '#f5a623',
      clusterText: '#ffffff',
      hoverRing: 'rgba(255, 255, 255, 0.92)',
      pillBg: 'rgba(10, 11, 15, 0.90)',
      pillBorder: 'rgba(255, 255, 255, 0.15)',
      pillText: '#ededed',
      pillSubText: '#a1a1a1',
      scaleBarLine: 'rgba(255, 255, 255, 0.32)',
      scaleBarText: 'rgba(255, 255, 255, 0.48)',
      emptyText: 'rgba(255, 255, 255, 0.38)',
    };
  }

  function normalizePoint(raw, fallbackDay, isActiveDay, orderIndex) {
    if (!raw || raw.lat == null || raw.lng == null) return null;
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

    const clampedLat = clamp(lat, MIN_LAT, MAX_LAT);
    const distFromHome = haversineKm(HOME_LAT, HOME_LNG, clampedLat, lng);
    const isTrip = Boolean(raw.isTrip || raw.is_trip || distFromHome > AWAY_THRESHOLD_KM);
    const day = raw.day ? String(raw.day) : (fallbackDay ? String(fallbackDay) : '');
    const label = String(raw.label || raw.title || raw.primary_place || 'Location').trim();

    return {
      raw,
      day,
      lat: clampedLat,
      lng,
      mx: lngToMercX(lng),
      my: latToMercY(clampedLat),
      label,
      time: raw.time ? String(raw.time) : '',
      source: raw.source ? String(raw.source) : '',
      photoCount: Number(raw.photo_count || raw.photoCount || 0) || 0,
      isTrip,
      isActiveDay: Boolean(isActiveDay),
      orderIndex: orderIndex != null ? orderIndex : -1,
      screenX: 0,
      screenY: 0,
    };
  }

  class KizukiReplayMap {
    constructor(canvas, options) {
      if (!canvas) {
        throw new Error('KizukiReplayMap requires a canvas element');
      }
      ensureReplayMapHudStyles();
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.options = options || {};
      this.palette = resolvePalette();

      this.width = 0;
      this.height = 0;
      this.dpr = 1;
      this._destroyed = false;
      this._needsFitOnVisible = true;
      this._hasUserSetRegion = false;
      this._hasInitialCamera = false;
      this._hasInitialData = false;

      // Motion preference & deterministic RAF animation state (auto-pauses when hidden/offscreen/reduced)
      this.reducedMotion = Boolean(
        global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
      this._rafId = null;
      this._camTween = null;
      this._arcAnim = null;
      this._arcProgress = 1;
      this._lastRenderStats = null;

      // Live Route Comet Engine state
      this._lastTickTs = null;
      this._cometDistPx = 0;
      this._cometRestRemaining = 0;
      this._cometManualT = null;
      this._cometTriggeredPins = new Set();
      this._pinPulses = [];
      this._isPageVisible =
        typeof document === 'undefined' || !document ? true : !document.hidden;
      this._isIntersecting = true;
      this._io = null;
      this._detailObserver = null;

      // Data
      this.points = [];
      this.dayPoints = [];
      this.archiveArcs = [];
      this.dayArcs = [];
      this._archiveClusters = [];
      this._archiveSingles = [];
      this.selectedDay = null;
      this.region = 'uk';

      // Camera in normalized Web Mercator [0..1]
      this.cam = {
        cx: lngToMercX(-2.5),
        cy: latToMercY(54.2),
        scale: 1200,
      };

      // Interaction state
      this.hoveredPoint = null;
      this._isDragging = false;
      this._pointerMoved = false;
      this._downPos = { x: 0, y: 0 };
      this._lastPos = { x: 0, y: 0 };
      this._activePointers = new Map();
      this._lastPinchDist = 0;

      this._bindHandlers();
      this._attachListeners();
      this.resize();
      this._fitRegionInternal(this.region, { animate: false });
      this._draw();
    }

    get rafId() {
      return this._rafId;
    }

    _shouldReduceMotion() {
      if (this.reducedMotion) return true;
      if (this.options && this.options.detail === 'off') return true;
      try {
        const docEl =
          typeof document !== 'undefined' && document && document.documentElement
            ? document.documentElement
            : null;
        if (
          docEl && (
            (docEl.dataset && docEl.dataset.detail === 'off') ||
            (typeof docEl.getAttribute === 'function' && docEl.getAttribute('data-detail') === 'off')
          )
        ) {
          return true;
        }
      } catch (_err) {
        // Ignore in non-DOM test environments
      }
      return false;
    }

    _finishAnimationsImmediately() {
      if (this._camTween) {
        this.cam.cx = this._camTween.targetCx;
        this.cam.cy = this._camTween.targetCy;
        this.cam.scale = this._camTween.targetScale;
        this._clampCamera();
        this._camTween = null;
      }
      this._arcAnim = null;
      this._arcProgress = 1;
      this._pinPulses = [];
      this._lastTickTs = null;
    }

    _cancelCameraTween() {
      if (this._camTween) {
        this._camTween = null;
        this._syncAnimationLoop();
      }
    }

    _triggerArcDrawIn() {
      const hasArcs = this.archiveArcs.length > 0 || this.dayArcs.length > 0;
      if (
        !hasArcs ||
        this._destroyed ||
        this._shouldReduceMotion() ||
        typeof requestAnimationFrame !== 'function' ||
        this.width < 10 ||
        this.height < 10
      ) {
        this._arcAnim = null;
        this._arcProgress = 1;
        this._syncAnimationLoop();
        return;
      }
      this._arcProgress = 0.02;
      this._arcAnim = {
        startTs: nowMs(),
        duration: ARC_ANIM_MS,
      };
      this._syncAnimationLoop();
    }

    _bindHandlers() {
      this._onPointerDown = this._handlePointerDown.bind(this);
      this._onPointerMove = this._handlePointerMove.bind(this);
      this._onPointerUp = this._handlePointerUp.bind(this);
      this._onPointerLeave = this._handlePointerLeave.bind(this);
      this._onWheel = this._handleWheel.bind(this);
      this._onDblClick = this._handleDblClick.bind(this);
      this._onWindowResize = () => this.resize();
      this._onMotionChange = (e) => {
        this.reducedMotion = Boolean(e && e.matches);
        if (this._shouldReduceMotion()) {
          this._finishAnimationsImmediately();
        }
        this._syncAnimationLoop();
        this._draw();
      };
      this._onVisibilityChange = () => {
        this._isPageVisible =
          typeof document === 'undefined' || !document ? true : !document.hidden;
        if (!this._isPageVisible) {
          this._lastTickTs = null;
        }
        this._syncAnimationLoop();
      };
      this._onTick = this._tick.bind(this);
    }

    _attachListeners() {
      const c = this.canvas;
      if (c.style) {
        c.style.touchAction = 'none';
        c.style.cursor = 'grab';
      }
      if (typeof c.addEventListener === 'function') {
        c.addEventListener('pointerdown', this._onPointerDown);
        c.addEventListener('pointermove', this._onPointerMove);
        c.addEventListener('pointerup', this._onPointerUp);
        c.addEventListener('pointercancel', this._onPointerUp);
        c.addEventListener('pointerleave', this._onPointerLeave);
        c.addEventListener('wheel', this._onWheel, { passive: false });
        c.addEventListener('dblclick', this._onDblClick);
      }

      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(c.parentElement || c);
      } else if (typeof global.addEventListener === 'function') {
        global.addEventListener('resize', this._onWindowResize);
      }

      if (typeof IntersectionObserver === 'function' && c) {
        try {
          this._io = new IntersectionObserver((entries) => {
            if (!entries || !entries.length) return;
            const entry = entries[entries.length - 1];
            this._isIntersecting = Boolean(entry && (entry.isIntersecting || entry.intersectionRatio > 0));
            if (!this._isIntersecting) {
              this._lastTickTs = null;
            }
            this._syncAnimationLoop();
          }, { threshold: 0.01 });
          this._io.observe(c);
        } catch (_err) {
          this._io = null;
          this._isIntersecting = true;
        }
      }

      if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', this._onVisibilityChange);
      }

      if (
        typeof MutationObserver === 'function' &&
        typeof document !== 'undefined' &&
        document &&
        document.documentElement
      ) {
        try {
          this._detailObserver = new MutationObserver(() => {
            if (this._destroyed) return;
            if (this._shouldReduceMotion()) {
              this._finishAnimationsImmediately();
            }
            this._syncAnimationLoop();
            this._draw();
          });
          this._detailObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-detail'],
          });
        } catch (_err) {
          this._detailObserver = null;
        }
      }

      if (global.matchMedia) {
        this._motionQuery = global.matchMedia('(prefers-reduced-motion: reduce)');
        if (this._motionQuery && this._motionQuery.addEventListener) {
          this._motionQuery.addEventListener('change', this._onMotionChange);
        } else if (this._motionQuery && this._motionQuery.addListener) {
          this._motionQuery.addListener(this._onMotionChange);
        }
      }
    }

    destroy() {
      this._destroyed = true;
      this._camTween = null;
      this._arcAnim = null;
      this._pinPulses = [];
      this._cometTriggeredPins.clear();
      this._cometManualT = null;
      this._lastTickTs = null;
      if (this._rafId != null) {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(this._rafId);
        }
        this._rafId = null;
      }
      const c = this.canvas;
      if (typeof c.removeEventListener === 'function') {
        c.removeEventListener('pointerdown', this._onPointerDown);
        c.removeEventListener('pointermove', this._onPointerMove);
        c.removeEventListener('pointerup', this._onPointerUp);
        c.removeEventListener('pointercancel', this._onPointerUp);
        c.removeEventListener('pointerleave', this._onPointerLeave);
        c.removeEventListener('wheel', this._onWheel);
        c.removeEventListener('dblclick', this._onDblClick);
      }

      if (this._ro) {
        this._ro.disconnect();
        this._ro = null;
      } else if (typeof global.removeEventListener === 'function') {
        global.removeEventListener('resize', this._onWindowResize);
      }

      if (this._io) {
        this._io.disconnect();
        this._io = null;
      }

      if (this._detailObserver) {
        this._detailObserver.disconnect();
        this._detailObserver = null;
      }

      if (typeof document !== 'undefined' && document && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
      }

      if (this._motionQuery) {
        if (this._motionQuery.removeEventListener) {
          this._motionQuery.removeEventListener('change', this._onMotionChange);
        } else if (this._motionQuery.removeListener) {
          this._motionQuery.removeListener(this._onMotionChange);
        }
        this._motionQuery = null;
      }

      this._activePointers.clear();
      this.hoveredPoint = null;
    }

    resize() {
      if (this._destroyed) return;
      const parent = this.canvas.parentElement;
      const rect = parent && typeof parent.getBoundingClientRect === 'function'
        ? parent.getBoundingClientRect()
        : (typeof this.canvas.getBoundingClientRect === 'function'
          ? this.canvas.getBoundingClientRect()
          : { width: this.canvas.width || 0, height: this.canvas.height || 0 });
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w < 10 || h < 10) return;

      const dpr = Math.min(global.devicePixelRatio || 1, 2.5);
      const wasHidden = this.width < 10 || this.height < 10;
      if (!wasHidden && w === this.width && h === this.height && dpr === this.dpr) {
        return;
      }

      this.width = w;
      this.height = h;
      this.dpr = dpr;

      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
      if (this.canvas.style) {
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
      }

      if (wasHidden && this._needsFitOnVisible) {
        this._needsFitOnVisible = false;
        this._fitRegionInternal(this.region, { animate: false });
      }

      // Synchronous draw immediately after resize prevents canvas flash
      this._draw();
      this._syncAnimationLoop();
    }

    refreshTheme() {
      if (this._destroyed) return;
      this.palette = resolvePalette();
      this._draw();
    }

    setData(payload) {
      if (this._destroyed) return;
      const data = payload || {};
      const rawPoints = Array.isArray(data.points) ? data.points : [];
      const selectedDay = data.selectedDay ? String(data.selectedDay) : null;
      const prevDay = this.selectedDay;
      const prevDayKey = this.dayPoints
        .map((p) => p.lat.toFixed(4) + ',' + p.lng.toFixed(4))
        .join('|');
      this.selectedDay = selectedDay;

      // Normalize archive points
      const normPoints = [];
      for (let i = 0; i < rawPoints.length; i += 1) {
        const pt = normalizePoint(rawPoints[i], null, false, -1);
        if (pt) normPoints.push(pt);
      }
      normPoints.sort((a, b) => a.day.localeCompare(b.day));
      this.points = normPoints;

      // Normalize selected day points
      const rawDayPoints = Array.isArray(data.dayPoints)
        ? data.dayPoints
        : (selectedDay ? rawPoints.filter((p) => p && String(p.day || '') === selectedDay) : []);

      const normDayPoints = [];
      for (let i = 0; i < rawDayPoints.length; i += 1) {
        const pt = normalizePoint(rawDayPoints[i], selectedDay, true, normDayPoints.length);
        if (pt) normDayPoints.push(pt);
      }
      this.dayPoints = normDayPoints;

      const nextDayKey = this.dayPoints
        .map((p) => p.lat.toFixed(4) + ',' + p.lng.toFixed(4))
        .join('|');
      const dayChanged = this._hasInitialData && (prevDay !== selectedDay || prevDayKey !== nextDayKey);

      this._rebuildArcs();
      this.hoveredPoint = null;

      // Default region: 'day' if dayPoints exist else 'uk'
      if (!this._hasUserSetRegion) {
        this.region = this.dayPoints.length > 0 ? 'day' : 'uk';
      }

      const animateFit = this._hasInitialData;
      if (this.region === 'day' || !this._hasUserSetRegion) {
        this._fitRegionInternal(this.region, { animate: animateFit });
      }
      if (dayChanged) {
        this._resetCometProgress();
        this._triggerArcDrawIn();
      } else if (!this._hasInitialData) {
        this._resetCometProgress();
        this._arcAnim = null;
        this._arcProgress = 1;
      }

      this._hasInitialData = true;
      this._draw();
      this._syncAnimationLoop();
    }

    setRegion(region) {
      if (this._destroyed) return;
      const normalized = String(region || '').toLowerCase();
      const prevRegion = this.region;
      if (normalized === 'day' || normalized === 'uk' || normalized === 'europe' || normalized === 'world') {
        this.region = normalized;
      } else {
        this.region = this.dayPoints.length > 0 ? 'day' : 'uk';
      }
      this._hasUserSetRegion = true;
      this._fitRegionInternal(this.region, { animate: true });
      if (prevRegion !== this.region || this._hasInitialData) {
        this._resetCometProgress();
        this._triggerArcDrawIn();
      }
      this._draw();
      this._syncAnimationLoop();
    }

    fitView() {
      if (this._destroyed) return;
      this._fitRegionInternal(this.region, { animate: true });
      this._draw();
      this._syncAnimationLoop();
    }

    zoomBy(factor) {
      if (this._destroyed) return;
      const f = Number(factor);
      if (!Number.isFinite(f) || f <= 0) return;
      this._cancelCameraTween();
      const cx = this.width * 0.5;
      const cy = this.height * 0.5;
      this._zoomAtScreen(cx, cy, f);
      this._draw();
    }

    setPlaybackProgress(t) {
      if (this._destroyed) return;
      if (t === null || t === undefined || t === '') {
        this._cometManualT = null;
        this._lastTickTs = null;
        this._syncAnimationLoop();
        this._draw();
        return;
      }
      const num = Number(t);
      if (!Number.isFinite(num)) return;
      const clampedT = clamp(num, 0, 1);
      const prevT = this._cometManualT;
      this._cometManualT = clampedT;
      this._cometRestRemaining = 0;

      // Sync comet distance and trigger crisp arrival pulses when scrubbing past waypoints
      const poly = this._buildCometPolyline();
      if (poly && poly.totalPx >= 12) {
        const nextDist = clampedT * poly.totalPx;
        const prevDist = prevT !== null ? prevT * poly.totalPx : this._cometDistPx;
        this._cometDistPx = nextDist;
        if (!this._shouldReduceMotion() && prevT !== null && nextDist !== prevDist) {
          const lo = Math.min(prevDist, nextDist);
          const hi = Math.max(prevDist, nextDist);
          const now = nowMs();
          for (let i = 0; i < poly.pinStops.length; i += 1) {
            const stop = poly.pinStops[i];
            if (stop.distPx >= lo && stop.distPx <= hi) {
              this._triggerPinPulse(stop.point, now);
            }
          }
        }
      }

      this._draw();
      this._syncAnimationLoop();
    }

    _rebuildArcs() {
      const atlas = getGeoAtlas();
      // Build chronological archive travel arcs (between distinct locations >= 18km apart)
      const archiveArcs = [];
      let prev = null;
      const seenPairs = new Set();
      for (let i = 0; i < this.points.length; i += 1) {
        const cur = this.points[i];
        if (prev) {
          const dist = haversineKm(prev.lat, prev.lng, cur.lat, cur.lng);
          if (dist >= 18) {
            const key =
              prev.lat.toFixed(2) + ',' + prev.lng.toFixed(2) + '->' +
              cur.lat.toFixed(2) + ',' + cur.lng.toFixed(2);
            if (!seenPairs.has(key)) {
              seenPairs.add(key);
              const isTripArc = prev.isTrip || cur.isTrip || dist > 60;
              const rawPts =
                atlas && typeof atlas.getGreatCirclePoints === 'function'
                  ? atlas.getGreatCirclePoints(prev.lat, prev.lng, cur.lat, cur.lng, GEODESIC_SEGMENTS, 1)
                  : sampleGreatCircle(prev.lat, prev.lng, cur.lat, cur.lng, dist > 500 ? GEODESIC_SEGMENTS : 20);
              const samples = rawPts.map((ll) => [lngToMercX(ll[0]), latToMercY(ll[1])]);
              archiveArcs.push({
                from: prev,
                to: cur,
                distKm: dist,
                isTripArc,
                samples,
              });
            }
          }
        }
        prev = cur;
      }
      this.archiveArcs = archiveArcs;

      // Build sequential active day route arcs
      const dayArcs = [];
      for (let i = 1; i < this.dayPoints.length; i += 1) {
        const a = this.dayPoints[i - 1];
        const b = this.dayPoints[i];
        const dist = haversineKm(a.lat, a.lng, b.lat, b.lng);
        if (dist < 0.05) continue;
        let samples = null;
        if (dist >= 60) {
          const rawPts =
            atlas && typeof atlas.getGreatCirclePoints === 'function'
              ? atlas.getGreatCirclePoints(a.lat, a.lng, b.lat, b.lng, GEODESIC_SEGMENTS, 1)
              : sampleGreatCircle(a.lat, a.lng, b.lat, b.lng, GEODESIC_SEGMENTS);
          samples = rawPts.map((ll) => [lngToMercX(ll[0]), latToMercY(ll[1])]);
        }
        dayArcs.push({ from: a, to: b, distKm: dist, samples, legIndex: i - 1 });
      }
      this.dayArcs = dayArcs;
    }

    _getMinScale() {
      const w = Math.max(240, this.width || 640);
      const h = Math.max(180, this.height || 400);
      return Math.max(w * 0.72, h * 0.85, 220);
    }

    _getMaxScale() {
      return 8000000;
    }

    _clampCameraObj(cam) {
      const minScale = this._getMinScale();
      const maxScale = this._getMaxScale();
      cam.scale = clamp(cam.scale, minScale, maxScale);
      const halfH = (this.height || 400) * 0.5 / cam.scale;
      const minCy = clamp(0.05 + halfH, 0.05, 0.5);
      const maxCy = clamp(0.95 - halfH, 0.5, 0.95);
      cam.cy = clamp(cam.cy, minCy, maxCy);
      cam.cx = clamp(cam.cx, 0.02, 0.98);
      return cam;
    }

    _clampCamera() {
      this._clampCameraObj(this.cam);
    }

    _computeFitTarget(bounds, padRatio) {
      const w = this.width;
      const h = this.height;
      if (w < 10 || h < 10) {
        this._needsFitOnVisible = true;
        return null;
      }

      const minLat = clamp(bounds.minLat, MIN_LAT, MAX_LAT);
      const maxLat = clamp(bounds.maxLat, MIN_LAT, MAX_LAT);
      const minLng = clamp(bounds.minLng, -180, 180);
      const maxLng = clamp(bounds.maxLng, -180, 180);

      const x1 = lngToMercX(minLng);
      const x2 = lngToMercX(maxLng);
      const y1 = latToMercY(maxLat); // North = smaller Mercator Y
      const y2 = latToMercY(minLat); // South = larger Mercator Y

      const dx = Math.max(1e-5, Math.abs(x2 - x1));
      const dy = Math.max(1e-5, Math.abs(y2 - y1));
      const pad = clamp(padRatio != null ? padRatio : 0.12, 0.04, 0.35);

      const padX = Math.min(Math.max(36, w * pad), w * 0.38);
      const padY = Math.min(Math.max(44, h * pad), h * 0.38);
      const usableW = Math.max(24, w - padX * 2);
      const usableH = Math.max(24, h - padY * 2);

      const scaleX = usableW / dx;
      const scaleY = usableH / dy;
      return this._clampCameraObj({
        scale: clamp(Math.min(scaleX, scaleY), this._getMinScale(), this._getMaxScale()),
        cx: (x1 + x2) * 0.5,
        cy: (y1 + y2) * 0.5,
      });
    }

    _applyCameraTarget(target, opts) {
      if (!target) return;
      const wantAnimate = Boolean(opts && opts.animate);
      const fromLng = mercXToLng(this.cam.cx);
      const fromLat = mercYToLat(this.cam.cy);
      const fromZoom = Math.log2(Math.max(1, this.cam.scale));
      const toLng = mercXToLng(target.cx);
      const toLat = mercYToLat(target.cy);
      const toZoom = Math.log2(Math.max(1, target.scale));

      const isAlreadyAtTarget =
        Math.abs(toLng - fromLng) < 1e-4 &&
        Math.abs(toLat - fromLat) < 1e-4 &&
        Math.abs(toZoom - fromZoom) < 1e-3;

      const canAnimate =
        wantAnimate &&
        this._hasInitialCamera &&
        !this._shouldReduceMotion() &&
        typeof requestAnimationFrame === 'function' &&
        this.width >= 10 &&
        this.height >= 10;

      if (!canAnimate || isAlreadyAtTarget) {
        this._camTween = null;
        this.cam.cx = target.cx;
        this.cam.cy = target.cy;
        this.cam.scale = target.scale;
        this._clampCamera();
        this._hasInitialCamera = true;
        this._syncAnimationLoop();
        return;
      }

      // If an active tween is already heading to the exact same destination, preserve its rhythm
      if (
        this._camTween &&
        Math.abs(this._camTween.toLng - toLng) < 1e-4 &&
        Math.abs(this._camTween.toLat - toLat) < 1e-4 &&
        Math.abs(this._camTween.toZoom - toZoom) < 1e-3
      ) {
        return;
      }

      this._camTween = {
        fromLng,
        fromLat,
        fromZoom,
        toLng,
        toLat,
        toZoom,
        targetCx: target.cx,
        targetCy: target.cy,
        targetScale: target.scale,
        startTs: nowMs(),
        duration: CAMERA_TWEEN_MS,
      };
      this._syncAnimationLoop();
    }

    _fitBounds(bounds, padRatio, opts) {
      const target = this._computeFitTarget(bounds, padRatio);
      this._applyCameraTarget(target, opts);
    }

    _fitRegionInternal(region, opts) {
      if (region === 'day') {
        if (this.dayPoints.length === 0) {
          this._fitBounds(REGION_PRESETS.uk, 0.12, opts);
          return;
        }
        if (this.dayPoints.length === 1) {
          const p = this.dayPoints[0];
          const nearLondon = haversineKm(HOME_LAT, HOME_LNG, p.lat, p.lng) <= 45;
          const halfLng = nearLondon ? 0.36 : 1.35;
          const halfLat = nearLondon ? 0.20 : 0.78;
          this._fitBounds({
            minLat: clamp(p.lat - halfLat, MIN_LAT, MAX_LAT),
            maxLat: clamp(p.lat + halfLat, MIN_LAT, MAX_LAT),
            minLng: clamp(p.lng - halfLng, -179, 179),
            maxLng: clamp(p.lng + halfLng, -179, 179),
          }, 0.18, opts);
          return;
        }

        let minLat = Infinity;
        let maxLat = -Infinity;
        let minLng = Infinity;
        let maxLng = -Infinity;
        const includeCoord = (lat, lng) => {
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
        };
        for (let i = 0; i < this.dayPoints.length; i += 1) {
          includeCoord(this.dayPoints[i].lat, this.dayPoints[i].lng);
        }
        const atlas = getGeoAtlas();
        if (atlas && typeof atlas.getGreatCirclePoints === 'function' && Array.isArray(this.dayArcs)) {
          for (let i = 0; i < this.dayArcs.length; i += 1) {
            const arc = this.dayArcs[i];
            if (!arc || !arc.from || !arc.to || arc.distKm < 25) continue;
            const gc = atlas.getGreatCirclePoints(arc.from.lat, arc.from.lng, arc.to.lat, arc.to.lng, 12, 1);
            for (let j = 0; j < gc.length; j += 1) {
              includeCoord(gc[j][1], gc[j][0]);
            }
          }
        }
        const spanLat = Math.max(0.22, maxLat - minLat);
        const spanLng = Math.max(0.36, maxLng - minLng);
        const midLat = (minLat + maxLat) * 0.5;
        const midLng = (minLng + maxLng) * 0.5;

        this._fitBounds({
          minLat: clamp(midLat - spanLat * 0.62, MIN_LAT, MAX_LAT),
          maxLat: clamp(midLat + spanLat * 0.62, MIN_LAT, MAX_LAT),
          minLng: clamp(midLng - spanLng * 0.62, -179, 179),
          maxLng: clamp(midLng + spanLng * 0.62, -179, 179),
        }, 0.24, opts);
        return;
      }

      const preset = REGION_PRESETS[region] || REGION_PRESETS.uk;
      this._fitBounds(preset, region === 'world' ? 0.08 : 0.11, opts);
    }

    _computeFitForRegion(region) {
      this._fitRegionInternal(region, { animate: false });
    }

    _mercToScreenX(mx) {
      return this.width * 0.5 + (mx - this.cam.cx) * this.cam.scale;
    }

    _mercToScreenY(my) {
      return this.height * 0.5 + (my - this.cam.cy) * this.cam.scale;
    }

    _screenToMercX(sx) {
      return this.cam.cx + (sx - this.width * 0.5) / this.cam.scale;
    }

    _screenToMercY(sy) {
      return this.cam.cy + (sy - this.height * 0.5) / this.cam.scale;
    }

    _getSpanLon() {
      if (!this.width || !this.cam.scale) return 360;
      return (this.width / this.cam.scale) * 360;
    }

    _zoomAtScreen(sx, sy, factor) {
      const beforeMx = this._screenToMercX(sx);
      const beforeMy = this._screenToMercY(sy);
      this.cam.scale = clamp(this.cam.scale * factor, this._getMinScale(), this._getMaxScale());
      this.cam.cx = beforeMx - (sx - this.width * 0.5) / this.cam.scale;
      this.cam.cy = beforeMy - (sy - this.height * 0.5) / this.cam.scale;
      this._clampCamera();
    }

    // =========================================================================
    // POINTER & WHEEL INTERACTION
    // =========================================================================

    _getCanvasPoint(evt) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: evt.clientX - rect.left,
        y: evt.clientY - rect.top,
      };
    }

    _hitTest(sx, sy) {
      const maxDistSq = HIT_RADIUS_PX * HIT_RADIUS_PX;
      let best = null;
      let bestDistSq = maxDistSq;

      // Priority 1: Active day points
      for (let i = this.dayPoints.length - 1; i >= 0; i -= 1) {
        const pt = this.dayPoints[i];
        const dx = pt.screenX - sx;
        const dy = pt.screenY - sy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestDistSq) {
          bestDistSq = d2;
          best = pt;
        }
      }
      if (best) return best;

      // Priority 2: Archive spatial clusters
      for (let i = this._archiveClusters.length - 1; i >= 0; i -= 1) {
        const cl = this._archiveClusters[i];
        const hitR = Math.max(HIT_RADIUS_PX, cl.r + 4);
        const dx = cl.x - sx;
        const dy = cl.y - sy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= hitR * hitR && d2 <= bestDistSq) {
          bestDistSq = d2;
          best = cl.rep;
        }
      }
      if (best) return best;

      const singles = this._archiveSingles.length > 0 ? this._archiveSingles : this.points;

      // Priority 3: Trip archive points (excluding active day overlaps)
      for (let i = singles.length - 1; i >= 0; i -= 1) {
        const pt = singles[i];
        if (!pt.isTrip || this._isExcludedArchivePoint(pt)) continue;
        const dx = pt.screenX - sx;
        const dy = pt.screenY - sy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestDistSq) {
          bestDistSq = d2;
          best = pt;
        }
      }
      if (best) return best;

      // Priority 4: Local archive points (excluding active day overlaps)
      for (let i = singles.length - 1; i >= 0; i -= 1) {
        const pt = singles[i];
        if (pt.isTrip || this._isExcludedArchivePoint(pt)) continue;
        const dx = pt.screenX - sx;
        const dy = pt.screenY - sy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestDistSq) {
          bestDistSq = d2;
          best = pt;
        }
      }
      return best;
    }

    _updateHover(point, sx, sy) {
      const changed = point !== this.hoveredPoint;
      this.hoveredPoint = point;

      if (this.canvas.style) {
        if (this._isDragging) {
          this.canvas.style.cursor = 'grabbing';
        } else {
          this.canvas.style.cursor = point ? 'pointer' : 'grab';
        }
      }

      if (changed) {
        if (typeof this.options.onHoverPoint === 'function') {
          if (point) {
            this.options.onHoverPoint(point.raw, point.screenX, point.screenY);
          } else {
            this.options.onHoverPoint(null, 0, 0);
          }
        }
        this._draw();
      } else if (point && typeof this.options.onHoverPoint === 'function') {
        this.options.onHoverPoint(point.raw, sx, sy);
      }
    }

    _handlePointerDown(evt) {
      if (evt.button !== undefined && evt.button !== 0 && evt.pointerType === 'mouse') return;
      this._cancelCameraTween();
      const pos = this._getCanvasPoint(evt);
      this._activePointers.set(evt.pointerId, pos);

      if (this.canvas.setPointerCapture) {
        try {
          this.canvas.setPointerCapture(evt.pointerId);
        } catch (_err) {
          // Ignore synthetic events without active pointer capture
        }
      }

      if (this._activePointers.size === 2) {
        const pts = Array.from(this._activePointers.values());
        this._lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        this._isDragging = false;
        this._pointerMoved = true;
        return;
      }

      this._isDragging = true;
      this._pointerMoved = false;
      this._downPos = pos;
      this._lastPos = pos;
      if (this.canvas.style) {
        this.canvas.style.cursor = 'grabbing';
      }
    }

    _handlePointerMove(evt) {
      const pos = this._getCanvasPoint(evt);
      if (this._activePointers.has(evt.pointerId)) {
        this._activePointers.set(evt.pointerId, pos);
      }

      // Two-finger touch pinch zoom
      if (this._activePointers.size === 2) {
        this._cancelCameraTween();
        const pts = Array.from(this._activePointers.values());
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        if (this._lastPinchDist > 4 && dist > 4) {
          const midX = (pts[0].x + pts[1].x) * 0.5;
          const midY = (pts[0].y + pts[1].y) * 0.5;
          this._zoomAtScreen(midX, midY, dist / this._lastPinchDist);
          this._draw();
        }
        this._lastPinchDist = dist;
        return;
      }

      if (this._isDragging) {
        const dx = pos.x - this._lastPos.x;
        const dy = pos.y - this._lastPos.y;
        const totalDist = Math.hypot(pos.x - this._downPos.x, pos.y - this._downPos.y);
        if (totalDist > 4) {
          this._pointerMoved = true;
        }
        if (this._pointerMoved) {
          this.cam.cx -= dx / this.cam.scale;
          this.cam.cy -= dy / this.cam.scale;
          this._clampCamera();
          this._lastPos = pos;
          if (this.hoveredPoint) {
            this._updateHover(null, 0, 0);
          } else {
            this._draw();
          }
        }
        return;
      }

      const hit = this._hitTest(pos.x, pos.y);
      this._updateHover(hit, pos.x, pos.y);
    }

    _handlePointerUp(evt) {
      const pos = this._getCanvasPoint(evt);
      this._activePointers.delete(evt.pointerId);
      if (this._activePointers.size < 2) {
        this._lastPinchDist = 0;
      }

      if (this.canvas.releasePointerCapture) {
        try {
          this.canvas.releasePointerCapture(evt.pointerId);
        } catch (_err) {
          // Ignore
        }
      }

      const wasClick = this._isDragging && !this._pointerMoved;
      this._isDragging = false;

      if (wasClick) {
        const hit = this._hitTest(pos.x, pos.y);
        if (hit && typeof this.options.onSelectDay === 'function') {
          const targetDay = hit.day || this.selectedDay || null;
          this.options.onSelectDay(targetDay, hit.raw);
        }
        this._updateHover(hit, pos.x, pos.y);
      } else {
        const hit = this._hitTest(pos.x, pos.y);
        if (this.canvas.style) {
          this.canvas.style.cursor = hit ? 'pointer' : 'grab';
        }
      }
    }

    _handlePointerLeave() {
      if (!this._isDragging && this.hoveredPoint) {
        this._updateHover(null, 0, 0);
      }
    }

    _handleWheel(evt) {
      evt.preventDefault();
      this._cancelCameraTween();
      const pos = this._getCanvasPoint(evt);
      const delta = clamp(-evt.deltaY, -180, 180);
      const factor = Math.exp(delta * 0.0022);
      this._zoomAtScreen(pos.x, pos.y, factor);
      this._draw();
    }

    _handleDblClick(evt) {
      this._cancelCameraTween();
      const pos = this._getCanvasPoint(evt);
      const hit = this._hitTest(pos.x, pos.y);
      if (hit) return;
      this._zoomAtScreen(pos.x, pos.y, 1.85);
      this._draw();
    }

    // =========================================================================
    // KINETIC 120 FPS ANIMATION & LIVE ROUTE COMET LOOP (AUTO-PAUSES WHEN HIDDEN)
    // =========================================================================

    _hasActiveCometTrack() {
      if (this.dayArcs.length > 0) return true;
      if (this.archiveArcs.length > 0 && (this.region !== 'day' || this._cometManualT !== null)) {
        return true;
      }
      return false;
    }

    _shouldRunCometLoop() {
      return (
        !this._destroyed &&
        !this._shouldReduceMotion() &&
        this._isPageVisible &&
        this._isIntersecting &&
        this.width >= 10 &&
        this.height >= 10 &&
        this._cometManualT === null &&
        this._hasActiveCometTrack()
      );
    }

    _syncAnimationLoop() {
      const cometActive = this._shouldRunCometLoop();
      const pulsesActive = this._pinPulses.length > 0 && !this._shouldReduceMotion();
      const hasWork = Boolean(this._camTween || this._arcAnim || cometActive || pulsesActive);
      const shouldAnimate =
        !this._destroyed &&
        !this._shouldReduceMotion() &&
        this._isPageVisible &&
        this._isIntersecting &&
        hasWork &&
        typeof requestAnimationFrame === 'function' &&
        this.width >= 10 &&
        this.height >= 10;

      if (shouldAnimate && this._rafId == null) {
        this._lastTickTs = null;
        this._rafId = requestAnimationFrame(this._onTick);
      } else if (!shouldAnimate && this._rafId != null) {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(this._rafId);
        }
        this._rafId = null;
        this._lastTickTs = null;
      }
    }

    _tick(ts) {
      if (this._destroyed) {
        this._rafId = null;
        this._lastTickTs = null;
        return;
      }
      if (this._shouldReduceMotion()) {
        this._finishAnimationsImmediately();
        this._rafId = null;
        this._draw();
        return;
      }
      if (!this._isPageVisible || !this._isIntersecting) {
        this._rafId = null;
        this._lastTickTs = null;
        return;
      }

      const now = Number.isFinite(ts) ? ts : nowMs();
      const dt = this._lastTickTs != null ? clamp((now - this._lastTickTs) / 1000, 0, 0.05) : 0.016;
      this._lastTickTs = now;
      let stillActive = false;

      if (this._camTween) {
        const tw = this._camTween;
        const rawT = tw.duration > 0 ? clamp((now - tw.startTs) / tw.duration, 0, 1) : 1;
        if (rawT >= 1) {
          this.cam.cx = tw.targetCx;
          this.cam.cy = tw.targetCy;
          this.cam.scale = tw.targetScale;
          this._clampCamera();
          this._camTween = null;
        } else {
          const e = easeOutCubic(rawT);
          const curLng = tw.fromLng + (tw.toLng - tw.fromLng) * e;
          const curLat = tw.fromLat + (tw.toLat - tw.fromLat) * e;
          const curZoom = tw.fromZoom + (tw.toZoom - tw.fromZoom) * e;
          this.cam.cx = lngToMercX(curLng);
          this.cam.cy = latToMercY(curLat);
          this.cam.scale = Math.pow(2, curZoom);
          this._clampCamera();
          stillActive = true;
        }
      }

      if (this._arcAnim) {
        const aa = this._arcAnim;
        const rawT = aa.duration > 0 ? clamp((now - aa.startTs) / aa.duration, 0, 1) : 1;
        if (rawT >= 1) {
          this._arcProgress = 1;
          this._arcAnim = null;
        } else {
          this._arcProgress = easeOutCubic(rawT);
          stillActive = true;
        }
      }

      if (this._shouldRunCometLoop()) {
        this._stepComet(dt, now);
        stillActive = true;
      }

      if (this._pinPulses.length > 0) {
        const kept = [];
        for (let i = 0; i < this._pinPulses.length; i += 1) {
          if (now - this._pinPulses[i].startTs < PIN_PULSE_TOTAL_MS) {
            kept.push(this._pinPulses[i]);
          }
        }
        this._pinPulses = kept;
        if (this._pinPulses.length > 0) {
          stillActive = true;
        }
      }

      this._draw();

      if (stillActive && !this._destroyed) {
        this._rafId = requestAnimationFrame(this._onTick);
      } else {
        this._rafId = null;
        this._lastTickTs = null;
      }
    }

    // =========================================================================
    // RENDERING PIPELINE
    // =========================================================================

    _getVisibleBounds() {
      const minLng = clamp(mercXToLng(this._screenToMercX(0)), -180, 180);
      const maxLng = clamp(mercXToLng(this._screenToMercX(this.width)), -180, 180);
      const maxLat = clamp(mercYToLat(this._screenToMercY(0)), MIN_LAT, MAX_LAT);
      const minLat = clamp(mercYToLat(this._screenToMercY(this.height)), MIN_LAT, MAX_LAT);
      return { minLng, maxLng, minLat, maxLat };
    }

    _draw() {
      if (this._destroyed || this.width < 10 || this.height < 10) return;
      const ctx = this.ctx;
      const pal = this.palette;
      const w = this.width;
      const h = this.height;
      const spanLon = this._getSpanLon();
      const bounds = this._getVisibleBounds();
      const zoom = Math.max(0, Math.log2(360 / Math.max(0.02, spanLon)));
      const atlas = getGeoAtlas();
      const hasAtlas = Boolean(atlas && typeof atlas.drawCartographyLayer === 'function');

      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      // 1. Project point screen coordinates and build spatial clusters first so cartography labels avoid all pins & clusters
      for (let i = 0; i < this.points.length; i += 1) {
        const pt = this.points[i];
        pt.screenX = this._mercToScreenX(pt.mx);
        pt.screenY = this._mercToScreenY(pt.my);
      }
      for (let i = 0; i < this.dayPoints.length; i += 1) {
        const pt = this.dayPoints[i];
        pt.screenX = this._mercToScreenX(pt.mx);
        pt.screenY = this._mercToScreenY(pt.my);
      }
      this._buildArchiveClusters(w, h);

      // 2. Determine HUD-safe bottom-left compass & scale bar visibility
      const showScaleBar = w >= 480 && h >= 120;
      let showCompass = hasAtlas && w >= 480 && h >= 200;
      if (showCompass) {
        const compassBox = { x1: 0, y1: h - 62, x2: 54, y2: h };
        for (let i = 0; i < this.dayPoints.length; i += 1) {
          const dp = this.dayPoints[i];
          if (dp.screenX >= compassBox.x1 && dp.screenX <= compassBox.x2 && dp.screenY >= compassBox.y1 && dp.screenY <= compassBox.y2) {
            showCompass = false;
            break;
          }
        }
        if (showCompass) {
          for (let i = 0; i < this._archiveClusters.length; i += 1) {
            const cl = this._archiveClusters[i];
            if (cl.x + cl.r >= compassBox.x1 && cl.x - cl.r <= compassBox.x2 && cl.y + cl.r >= compassBox.y1 && cl.y - cl.r <= compassBox.y2) {
              showCompass = false;
              break;
            }
          }
        }
      }

      // 3. Plan foreground place pills up front so cartographic reference labels never sit beneath pills
      const pillPlan = this._planForegroundPills(ctx, pal, w, h, spanLon, showCompass);

      // 4. High-resolution offline cartography (KizukiGeoAtlas) or graceful internal fallback
      let graticule = null;
      let atlasRes = null;

      if (hasAtlas) {
        const projectFn = (lng, lat) => [
          this._mercToScreenX(lngToMercX(lng)),
          this._mercToScreenY(latToMercY(lat)),
        ];

        const activePins = [];
        const avoidPoints = [];
        for (let i = 0; i < this.dayPoints.length; i += 1) {
          const dp = this.dayPoints[i];
          if (dp.screenX < -24 || dp.screenX > w + 24 || dp.screenY < -24 || dp.screenY > h + 24) continue;
          activePins.push({ screenX: dp.screenX, screenY: dp.screenY, r: 22 });
          avoidPoints.push({ screenX: dp.screenX, screenY: dp.screenY, r: 22 });
        }
        if (this.hoveredPoint && !this.hoveredPoint.isActiveDay) {
          activePins.push({ screenX: this.hoveredPoint.screenX, screenY: this.hoveredPoint.screenY, r: 20 });
        }
        for (let i = 0; i < this._archiveClusters.length; i += 1) {
          const cl = this._archiveClusters[i];
          if (cl.x < -24 || cl.x > w + 24 || cl.y < -24 || cl.y > h + 24) continue;
          avoidPoints.push({ screenX: cl.x, screenY: cl.y, r: cl.r + 16 });
        }
        for (let i = 0; i < this._archiveSingles.length; i += 1) {
          const pt = this._archiveSingles[i];
          if (pt.screenX < -18 || pt.screenX > w + 18 || pt.screenY < -18 || pt.screenY > h + 18) continue;
          avoidPoints.push({ screenX: pt.screenX, screenY: pt.screenY, r: pt.isTrip ? 18 : 12 });
        }

        const hudSafeRects = [
          // Top HUD pill + region mode switcher bar
          { x1: 0, y1: 0, x2: w, y2: 44 },
          // Bottom-right zoom/fit controls
          { x1: Math.max(0, w - 124), y1: Math.max(0, h - 44), x2: w, y2: h },
          // Bottom margin guard
          { x1: 0, y1: Math.max(0, h - 22), x2: w, y2: h },
        ];
        if (showCompass) {
          hudSafeRects.push({ x1: 0, y1: Math.max(0, h - 64), x2: 56, y2: h });
          hudSafeRects.push({ x1: 50, y1: Math.max(0, h - 40), x2: 192, y2: h });
        } else if (showScaleBar) {
          hudSafeRects.push({ x1: 0, y1: Math.max(0, h - 40), x2: 144, y2: h });
        }

        const viewState = {
          width: w,
          height: h,
          dpr: this.dpr,
          cam: { cx: this.cam.cx, cy: this.cam.cy, scale: this.cam.scale },
          bounds,
          spanLon,
          zoom,
          activePins,
          avoidPoints,
          hudSafeRects,
          occupiedRects: pillPlan.placed,
          projectFn,
        };

        atlasRes = atlas.drawCartographyLayer(ctx, projectFn, viewState, pal);

        if (typeof atlas.drawTopographicGrid === 'function') {
          const showEdgeTicks = w >= 480;
          // Clip bottom 46px control bar safe zone on mobile (< 480px) so bottom-edge
          // vertical graticule ticks never poke out beneath the mode/zoom pill borders.
          // Always pass showEdgeTicks: false to atlas so coordinate labels render AFTER
          // route arcs via _drawGraticuleLabels with a 3.5px canvas-background halo.
          ctx.save();
          if (w < 480) {
            ctx.beginPath();
            ctx.rect(0, 0, w, Math.max(0, h - 46));
            ctx.clip();
          }
          atlas.drawTopographicGrid(ctx, w, h, pal, {
            projectFn,
            cam: viewState.cam,
            bounds,
            spanLon,
            zoom,
            showEdgeTicks: false,
            showCompass,
            compassCorner: 'bottom-left',
          });
          ctx.restore();
          if (showEdgeTicks) {
            graticule = this._computeAtlasGraticule(w, h, bounds, spanLon);
          }
        }
      } else {
        // Graceful fallback internal renderer when window.KizukiGeoAtlas is absent
        ctx.fillStyle = pal.ocean;
        ctx.fillRect(0, 0, w, h);
        this._drawLandmasses(ctx, pal, w, h);
        graticule = this._drawGraticuleLines(ctx, pal, w, h, spanLon);
        if (spanLon < 105) {
          this._drawCountryBorders(ctx, pal, spanLon);
        }
        if (spanLon < 2.4) {
          this._drawLondonGeography(ctx, pal, spanLon);
        }
      }

      // 5. Animated spherical geodesic archive travel arcs
      this._drawArchiveArcs(ctx, pal);

      // 6. Archive pins (blue local + amber away/trip + dense clusters)
      this._drawArchivePins(ctx, pal, w, h);

      // 7. Active selected day route arcs + directional chevrons
      this._drawDayArcs(ctx, pal);

      // 7b. Live luminous directional comet along active route polyline
      this._drawComet(ctx, pal);

      // 8. Active selected day pins + crisp arrival ring-pulses
      this._drawDayPins(ctx, pal, w, h);
      this._drawPinPulses(ctx, pal);

      // 9. Collision-free foreground pills (+ fallback anchor/context labels only when atlas is absent)
      this._renderForegroundPills(ctx, pal, pillPlan.pills);
      if (!hasAtlas) {
        this._drawFallbackContextLabels(ctx, pal, w, h, spanLon, pillPlan);
      }
      // 9b. Haloed coordinate labels drawn AFTER route arcs so routes never cut across labels (e.g. 51.5°N)
      if (graticule) {
        this._drawGraticuleLabels(ctx, pal, w, h, graticule, pillPlan.placedPillRects, hasAtlas);
      }

      // 10. Crisp cartographic scale bar (desktop >= 480px; hidden on mobile < 480px)
      this._drawScaleBar(ctx, pal, w, h, showCompass);

      this._lastRenderStats = {
        usedAtlas: hasAtlas,
        atlasLayers: atlasRes && Array.isArray(atlasRes.activeLayers) ? atlasRes.activeLayers : [],
        atlasPlacedLabels: atlasRes && Array.isArray(atlasRes.placedLabels) ? atlasRes.placedLabels : [],
        placedPills: pillPlan.placedPillRects,
        showCompass,
        showScaleBar,
        spanLon,
        zoom,
      };

      ctx.restore();
    }

    _isExcludedArchivePoint(pt) {
      if (this.selectedDay && pt.day === this.selectedDay) {
        return true;
      }
      for (let i = 0; i < this.dayPoints.length; i += 1) {
        const dp = this.dayPoints[i];
        if (Math.hypot(pt.screenX - dp.screenX, pt.screenY - dp.screenY) <= 24) {
          return true;
        }
      }
      return false;
    }

    _buildArchiveClusters(w, h) {
      const CLUSTER_RADIUS = 14;
      const groups = [];

      for (let i = 0; i < this.points.length; i += 1) {
        const pt = this.points[i];
        if (pt.screenX < -24 || pt.screenX > w + 24 || pt.screenY < -24 || pt.screenY > h + 24) {
          continue;
        }
        if (this._isExcludedArchivePoint(pt)) {
          continue;
        }

        let target = null;
        let bestDist = CLUSTER_RADIUS;
        for (let g = 0; g < groups.length; g += 1) {
          const grp = groups[g];
          const d = Math.hypot(pt.screenX - grp.x, pt.screenY - grp.y);
          if (d <= bestDist) {
            bestDist = d;
            target = grp;
          }
        }

        if (target) {
          target.points.push(pt);
          target.sumX += pt.screenX;
          target.sumY += pt.screenY;
          target.x = target.sumX / target.points.length;
          target.y = target.sumY / target.points.length;
          if (pt.isTrip) {
            target.tripCount += 1;
            target.repTrip = pt;
          } else {
            target.localCount += 1;
          }
          target.rep = target.repTrip || pt;
        } else {
          groups.push({
            x: pt.screenX,
            y: pt.screenY,
            sumX: pt.screenX,
            sumY: pt.screenY,
            points: [pt],
            tripCount: pt.isTrip ? 1 : 0,
            localCount: pt.isTrip ? 0 : 1,
            repTrip: pt.isTrip ? pt : null,
            rep: pt,
            r: 8.5,
          });
        }
      }

      const clusters = [];
      const singles = [];
      for (let g = 0; g < groups.length; g += 1) {
        const grp = groups[g];
        if (grp.points.length >= 3) {
          const count = grp.points.length;
          grp.r = count >= 100 ? 11.5 : (count >= 10 ? 10 : 8.5);
          grp.isTripCluster = grp.tripCount > grp.localCount;
          clusters.push(grp);
        } else {
          for (let j = 0; j < grp.points.length; j += 1) {
            singles.push(grp.points[j]);
          }
        }
      }

      // Merge any two cluster badges that would physically overlap each other
      for (let i = 0; i < clusters.length; i += 1) {
        const a = clusters[i];
        if (!a) continue;
        for (let j = i + 1; j < clusters.length; j += 1) {
          const b = clusters[j];
          if (!b) continue;
          if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + 3) {
            for (let k = 0; k < b.points.length; k += 1) {
              a.points.push(b.points[k]);
            }
            a.sumX += b.sumX;
            a.sumY += b.sumY;
            a.x = a.sumX / a.points.length;
            a.y = a.sumY / a.points.length;
            a.tripCount += b.tripCount;
            a.localCount += b.localCount;
            if (b.repTrip) a.repTrip = b.repTrip;
            a.rep = a.repTrip || b.rep;
            const c = a.points.length;
            a.r = c >= 100 ? 11.5 : (c >= 10 ? 10 : 8.5);
            a.isTripCluster = a.tripCount > a.localCount;
            clusters[j] = null;
          }
        }
      }

      this._archiveClusters = clusters.filter(Boolean);
      this._archiveSingles = singles;
    }

    _computeAtlasGraticule(w, h, bounds, spanLon) {
      // Mirrors KizukiGeoAtlas.drawTopographicGrid step selection so haloed coordinate labels
      // align pixel-exact with the topographic grid lines while rendering ABOVE route arcs.
      const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 45];
      const pickStep = (span) => {
        const target = Math.max(0.02, span) / 5.5;
        for (let i = 0; i < steps.length; i += 1) {
          if (steps[i] >= target) return steps[i];
        }
        return 45;
      };

      const minLng = clamp(bounds ? bounds.minLng : mercXToLng(this._screenToMercX(0)), -180, 180);
      const maxLng = clamp(bounds ? bounds.maxLng : mercXToLng(this._screenToMercX(w)), -180, 180);
      const minLat = clamp(bounds ? bounds.minLat : mercYToLat(this._screenToMercY(h)), -80, 80);
      const maxLat = clamp(bounds ? bounds.maxLat : mercYToLat(this._screenToMercY(0)), -80, 80);
      const stepLon = pickStep(spanLon);
      const stepLat = pickStep(Math.max(0.05, Math.abs(maxLat - minLat)) * 1.5);

      const lngLines = [];
      const startLng = Math.floor(minLng / stepLon) * stepLon;
      const endLng = Math.ceil(maxLng / stepLon) * stepLon + 1e-6;
      for (let lng = startLng; lng <= endLng; lng += stepLon) {
        if (lng < -180 || lng > 180) continue;
        const sx = this._mercToScreenX(lngToMercX(lng));
        if (sx >= 16 && sx <= w - 16) {
          lngLines.push({ sx, lng });
        }
      }

      const latLines = [];
      const startLat = Math.floor(minLat / stepLat) * stepLat;
      const endLat = Math.ceil(maxLat / stepLat) * stepLat + 1e-6;
      for (let lat = startLat; lat <= endLat; lat += stepLat) {
        if (lat < -80 || lat > 80) continue;
        const sy = this._mercToScreenY(latToMercY(lat));
        if (sy >= 16 && sy <= h - 16) {
          latLines.push({ sy, lat });
        }
      }
      return { lngLines, latLines };
    }

    _drawGraticuleLines(ctx, pal, w, h, spanLon) {
      const minLng = clamp(mercXToLng(this._screenToMercX(0)), -180, 180);
      const maxLng = clamp(mercXToLng(this._screenToMercX(w)), -180, 180);
      const maxLat = clamp(mercYToLat(this._screenToMercY(0)), MIN_LAT, MAX_LAT);
      const minLat = clamp(mercYToLat(this._screenToMercY(h)), MIN_LAT, MAX_LAT);

      const stepLon = pickGraticuleStep(spanLon);
      const stepLat = pickGraticuleStep(Math.max(0.02, maxLat - minLat));
      // On mobile (< 480px), keep bottom 46px control bar safe zone clear of vertical ticks
      const gridBottom = w < 480 ? Math.max(0, h - 46) : h;

      ctx.strokeStyle = pal.graticule;
      ctx.lineWidth = 1;
      ctx.beginPath();

      const startLng = Math.ceil(minLng / stepLon) * stepLon;
      const lngLines = [];
      for (let lng = startLng; lng <= maxLng + stepLon * 0.1; lng += stepLon) {
        if (lng < -180 || lng > 180) continue;
        const sx = Math.round(this._mercToScreenX(lngToMercX(lng))) + 0.5;
        if (sx < 0 || sx > w) continue;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, gridBottom);
        lngLines.push({ sx, lng });
      }

      const startLat = Math.ceil(minLat / stepLat) * stepLat;
      const latLines = [];
      for (let lat = startLat; lat <= maxLat + stepLat * 0.1; lat += stepLat) {
        if (lat < MIN_LAT || lat > MAX_LAT) continue;
        const sy = Math.round(this._mercToScreenY(latToMercY(lat))) + 0.5;
        if (sy < 0 || sy > gridBottom) continue;
        ctx.moveTo(0, sy);
        ctx.lineTo(w, sy);
        latLines.push({ sy, lat });
      }
      ctx.stroke();

      return { lngLines, latLines };
    }

    _drawGraticuleLabels(ctx, pal, w, h, graticule, placedLabelRects, isAtlasMode) {
      if (!graticule) return;
      const lngLines = graticule.lngLines || [];
      const latLines = graticule.latLines || [];
      const isNarrow = w < 480;

      // Collect visible rendered pins and clusters for proximity checks
      const renderedPins = [];
      let totalVisiblePinCount = 0;
      for (let i = 0; i < this.dayPoints.length; i += 1) {
        const pt = this.dayPoints[i];
        if (pt.screenX >= -8 && pt.screenX <= w + 8 && pt.screenY >= -8 && pt.screenY <= h + 8) {
          renderedPins.push({ x: pt.screenX, y: pt.screenY, r: 9 });
          totalVisiblePinCount += 1;
        }
      }
      for (let i = 0; i < this._archiveClusters.length; i += 1) {
        const cl = this._archiveClusters[i];
        if (cl.x >= -12 && cl.x <= w + 12 && cl.y >= -12 && cl.y <= h + 12) {
          renderedPins.push({ x: cl.x, y: cl.y, r: cl.r + 2 });
          totalVisiblePinCount += cl.points.length;
        }
      }
      for (let i = 0; i < this._archiveSingles.length; i += 1) {
        const pt = this._archiveSingles[i];
        if (pt.screenX >= -8 && pt.screenX <= w + 8 && pt.screenY >= -8 && pt.screenY <= h + 8) {
          renderedPins.push({ x: pt.screenX, y: pt.screenY, r: 5 });
          totalVisiblePinCount += 1;
        }
      }

      // Suppress edge graticule labels entirely on dense narrow (< 480px) mobile canvases
      if (isNarrow && (renderedPins.length >= 3 || totalVisiblePinCount >= 4)) {
        return;
      }

      const pinClearance = isNarrow ? 30 : 12;
      const labelClearance = isNarrow ? 30 : 8;
      const pillRects = Array.isArray(placedLabelRects) ? placedLabelRects : [];

      const isNearPinOrLabel = (rect) => {
        for (let i = 0; i < renderedPins.length; i += 1) {
          const p = renderedPins[i];
          const pad = p.r + pinClearance;
          const pinBox = {
            x1: p.x - pad,
            y1: p.y - pad,
            x2: p.x + pad,
            y2: p.y + pad,
          };
          if (rectsOverlap(rect, pinBox)) return true;
        }
        for (let i = 0; i < pillRects.length; i += 1) {
          const r = pillRects[i];
          const expanded = {
            x1: r.x1 - labelClearance,
            y1: r.y1 - labelClearance,
            x2: r.x2 + labelClearance,
            y2: r.y2 + labelClearance,
          };
          if (rectsOverlap(rect, expanded)) return true;
        }
        return false;
      };

      const drawHaloLabel = (text, x, y) => {
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = pal.ocean;
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      };

      ctx.save();
      // Subtle Geist Mono degree labels: longitude along bottom edge, latitude on left edge
      ctx.font = '500 9.5px ' + pal.fontMono;
      ctx.fillStyle = pal.graticuleText;
      ctx.textAlign = 'left';

      // Longitude labels at bottom edge (desktop only; clears bottom-left compass/scale & bottom-right controls)
      if (!isNarrow) {
        const bottomLeftSafe = 176;
        const bottomRightSafe = 132;
        let lastLngLabelX = -Infinity;
        ctx.textBaseline = 'bottom';
        for (let i = 0; i < lngLines.length; i += 1) {
          const item = lngLines[i];
          const label = formatCoordLabel(item.lng, false);
          const tw = ctx.measureText(label).width;
          if (item.sx < bottomLeftSafe || item.sx + 4 + tw > w - bottomRightSafe) continue;
          if (item.sx - lastLngLabelX < 52) continue;
          const rect = { x1: item.sx + 4, y1: h - 19, x2: item.sx + 4 + tw, y2: h - 7 };
          if (isNearPinOrLabel(rect)) continue;
          drawHaloLabel(label, item.sx + 4, h - 8);
          lastLngLabelX = item.sx;
        }
      }

      // Latitude labels along left edge, skipping top HUD band (y < 46) and bottom controls band (y > h - 48)
      const labelX = isAtlasMode ? 10 : 6;
      for (let i = 0; i < latLines.length; i += 1) {
        const item = latLines[i];
        if (item.sy < 46 || item.sy > h - 48) continue;
        const label = formatCoordLabel(item.lat, true);
        const tw = ctx.measureText(label).width;
        if (isAtlasMode) {
          const rect = { x1: labelX, y1: item.sy - 6, x2: labelX + tw, y2: item.sy + 6 };
          if (isNearPinOrLabel(rect)) continue;
          ctx.textBaseline = 'middle';
          drawHaloLabel(label, labelX, item.sy);
        } else {
          const isTopAligned = item.sy < 54;
          const rect = isTopAligned
            ? { x1: labelX, y1: item.sy + 3, x2: labelX + tw, y2: item.sy + 14 }
            : { x1: labelX, y1: item.sy - 14, x2: labelX + tw, y2: item.sy - 3 };
          if (isNearPinOrLabel(rect)) continue;
          if (isTopAligned) {
            ctx.textBaseline = 'top';
            drawHaloLabel(label, labelX, item.sy + 3);
          } else {
            ctx.textBaseline = 'bottom';
            drawHaloLabel(label, labelX, item.sy - 3);
          }
        }
      }
      ctx.restore();
    }

    _drawLandmasses(ctx, pal, w, h) {
      ctx.fillStyle = pal.landFill;
      ctx.strokeStyle = pal.landStroke;
      ctx.lineWidth = 1;
      ctx.lineJoin = 'round';

      ctx.beginPath();
      for (let p = 0; p < PROJECTED_LAND.length; p += 1) {
        const poly = PROJECTED_LAND[p];
        if (poly.length < 3) continue;

        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;

        for (let i = 0; i < poly.length; i += 1) {
          const sx = this._mercToScreenX(poly[i][0]);
          const sy = this._mercToScreenY(poly[i][1]);
          if (sx < minX) minX = sx;
          if (sx > maxX) maxX = sx;
          if (sy < minY) minY = sy;
          if (sy > maxY) maxY = sy;
        }
        // Viewport frustum cull
        if (maxX < -10 || minX > w + 10 || maxY < -10 || minY > h + 10) continue;

        const firstX = this._mercToScreenX(poly[0][0]);
        const firstY = this._mercToScreenY(poly[0][1]);
        ctx.moveTo(firstX, firstY);
        for (let i = 1; i < poly.length; i += 1) {
          ctx.lineTo(this._mercToScreenX(poly[i][0]), this._mercToScreenY(poly[i][1]));
        }
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    }

    _drawCountryBorders(ctx, pal, spanLon) {
      const alphaScale = clamp((105 - spanLon) / 45, 0.45, 1);
      ctx.save();
      ctx.globalAlpha = alphaScale;
      ctx.strokeStyle = pal.borderStroke;
      ctx.lineWidth = spanLon < 12 ? 1.15 : 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (let b = 0; b < PROJECTED_BORDERS.length; b += 1) {
        const line = PROJECTED_BORDERS[b];
        if (line.length < 2) continue;
        ctx.moveTo(this._mercToScreenX(line[0][0]), this._mercToScreenY(line[0][1]));
        for (let i = 1; i < line.length; i += 1) {
          ctx.lineTo(this._mercToScreenX(line[i][0]), this._mercToScreenY(line[i][1]));
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    _drawLondonGeography(ctx, pal, spanLon) {
      const fade = clamp((2.4 - spanLon) / 1.2, 0, 1);
      if (fade <= 0.01) return;

      ctx.save();
      ctx.globalAlpha = fade;

      // Subtle M25 Greater London orbital ring
      ctx.strokeStyle = pal.m25Stroke;
      ctx.lineWidth = 1.1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (let i = 0; i < PROJECTED_M25.length; i += 1) {
        const sx = this._mercToScreenX(PROJECTED_M25[i][0]);
        const sy = this._mercToScreenY(PROJECTED_M25[i][1]);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // River Thames smooth curved ribbon (quadratic midpoint smoothing)
      const ribbonW = clamp(2.2 + (1.2 - Math.min(spanLon, 1.2)) * 4.2, 2.0, 6.2);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = pal.thamesStroke;
      ctx.lineWidth = ribbonW;
      ctx.beginPath();
      const tPts = PROJECTED_THAMES.map((p) => [
        this._mercToScreenX(p[0]),
        this._mercToScreenY(p[1]),
      ]);
      if (tPts.length >= 2) {
        ctx.moveTo(tPts[0][0], tPts[0][1]);
        for (let i = 1; i < tPts.length - 1; i += 1) {
          const midX = (tPts[i][0] + tPts[i + 1][0]) * 0.5;
          const midY = (tPts[i][1] + tPts[i + 1][1]) * 0.5;
          ctx.quadraticCurveTo(tPts[i][0], tPts[i][1], midX, midY);
        }
        const last = tPts[tPts.length - 1];
        ctx.lineTo(last[0], last[1]);
      }
      ctx.stroke();

      // Inner crisp centerline highlight on Thames
      ctx.strokeStyle = pal.thamesHighlight;
      ctx.lineWidth = Math.max(1, ribbonW * 0.34);
      ctx.stroke();

      ctx.restore();
    }

    _traceGeodesicLonLat(ctx, llPoints) {
      if (!llPoints || llPoints.length < 2) return null;
      let lastX = 0;
      let lastY = 0;
      for (let s = 0; s < llPoints.length; s += 1) {
        const lng = llPoints[s][0];
        const lat = llPoints[s][1];
        const sx = this._mercToScreenX(lngToMercX(lng));
        const sy = this._mercToScreenY(latToMercY(lat));
        if (s === 0 || Math.abs(lng - llPoints[s - 1][0]) > 180) {
          ctx.moveTo(sx, sy);
        } else {
          ctx.lineTo(sx, sy);
        }
        lastX = sx;
        lastY = sy;
      }
      return { x: lastX, y: lastY };
    }

    _drawTaperedScreenPolyline(ctx, pts, strokeColor, glowColor, maxWidth, baseAlpha) {
      if (!pts || pts.length < 2) return;
      const segs = pts.length - 1;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let s = 0; s < segs; s += 1) {
        const a = pts[s];
        const b = pts[s + 1];
        if (!a || !b) continue;
        // Break across antimeridian jumps
        if (Math.abs(b[0] - a[0]) > this.width * 0.65) continue;
        const u = (s + 0.5) / segs;
        // Smooth cartographic taper: fine at endpoints, full at apex (sin curve)
        const taper = 0.34 + 0.66 * Math.sin(u * Math.PI);
        const wCore = Math.max(0.65, maxWidth * taper);
        if (glowColor) {
          ctx.globalAlpha = baseAlpha * (0.45 + 0.4 * taper);
          ctx.strokeStyle = glowColor;
          ctx.lineWidth = wCore * 2.15;
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        }
        ctx.globalAlpha = baseAlpha * (0.62 + 0.38 * taper);
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = wCore;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawArchiveArcs(ctx, pal) {
      if (this.archiveArcs.length === 0) return;

      const atlas = getGeoAtlas();
      const useAtlasGeodesic = Boolean(atlas && typeof atlas.getGreatCirclePoints === 'function');
      const progress = this._shouldReduceMotion() ? 1 : clamp(this._arcProgress, 0, 1);
      if (progress <= 0.005) return;

      ctx.save();
      for (let i = 0; i < this.archiveArcs.length; i += 1) {
        const arc = this.archiveArcs[i];
        const x1 = arc.from.screenX;
        const y1 = arc.from.screenY;
        const x2 = arc.to.screenX;
        const y2 = arc.to.screenY;
        // At tight Day zoom, suppress off-frame long-haul archive rays that run out of viewport
        if (this.region === 'day' && this._cometManualT === null) {
          const pad = 48;
          const p1In = x1 >= -pad && x1 <= this.width + pad && y1 >= -pad && y1 <= this.height + pad;
          const p2In = x2 >= -pad && x2 <= this.width + pad && y2 >= -pad && y2 <= this.height + pad;
          if (!p1In || !p2In) continue;
        }
        const chord = Math.hypot(x2 - x1, y2 - y1);
        if (chord < 8) continue;

        const screenPts = [];
        if (useAtlasGeodesic) {
          const geoPts = atlas.getGreatCirclePoints(
            arc.from.lat,
            arc.from.lng,
            arc.to.lat,
            arc.to.lng,
            GEODESIC_SEGMENTS,
            progress
          );
          for (let g = 0; g < geoPts.length; g += 1) {
            screenPts.push([
              this._mercToScreenX(lngToMercX(geoPts[g][0])),
              this._mercToScreenY(latToMercY(geoPts[g][1])),
            ]);
          }
        } else if (arc.distKm > 400 && arc.samples && arc.samples.length > 2) {
          const maxIdx = Math.max(1, Math.min(arc.samples.length - 1, Math.ceil((arc.samples.length - 1) * progress)));
          for (let s = 0; s <= maxIdx; s += 1) {
            screenPts.push([
              this._mercToScreenX(arc.samples[s][0]),
              this._mercToScreenY(arc.samples[s][1]),
            ]);
          }
        } else {
          const midX = (x1 + x2) * 0.5;
          const midY = (y1 + y2) * 0.5;
          const nx = -(y2 - y1) / chord;
          const ny = (x2 - x1) / chord;
          const lift = Math.min(44, chord * 0.16);
          const cpx = midX + nx * lift;
          const cpy = midY + ny * lift;
          const steps = 16;
          for (let s = 0; s <= steps; s += 1) {
            const t = (s / steps) * progress;
            const mt = 1 - t;
            screenPts.push([
              mt * mt * x1 + 2 * mt * t * cpx + t * t * x2,
              mt * mt * y1 + 2 * mt * t * cpy + t * t * y2,
            ]);
          }
        }

        const tipPt = screenPts.length > 0 ? screenPts[screenPts.length - 1] : null;
        this._drawTaperedScreenPolyline(
          ctx,
          screenPts,
          arc.isTripArc ? pal.tripPin : pal.archivePin,
          arc.isTripArc ? pal.tripArcGlow : pal.archiveArcGlow,
          arc.isTripArc ? 2.1 : 1.45,
          arc.isTripArc ? 0.62 : 0.44
        );

        if (tipPt && progress < 0.995) {
          ctx.beginPath();
          ctx.arc(tipPt[0], tipPt[1], arc.isTripArc ? 2.1 : 1.6, 0, Math.PI * 2);
          ctx.fillStyle = arc.isTripArc ? pal.tripPin : pal.archivePin;
          ctx.fill();
        }
      }
      ctx.restore();
    }

    _drawArchivePins(ctx, pal, w, h) {
      if (this._archiveSingles.length === 0 && this._archiveClusters.length === 0) return;

      // Pass 1 & 2: Individual non-clustered archive pins (blue local first, amber trip on top)
      for (let pass = 0; pass < 2; pass += 1) {
        const drawTrips = pass === 1;
        for (let i = 0; i < this._archiveSingles.length; i += 1) {
          const pt = this._archiveSingles[i];
          if (pt.isTrip !== drawTrips) continue;
          if (pt.screenX < -18 || pt.screenX > w + 18 || pt.screenY < -18 || pt.screenY > h + 18) {
            continue;
          }

          const isHovered = this.hoveredPoint === pt;
          const baseR = drawTrips ? 4.4 : 3.2;
          const r = isHovered ? baseR + 2.0 : baseR;

          ctx.beginPath();
          ctx.arc(pt.screenX, pt.screenY, r, 0, Math.PI * 2);
          ctx.fillStyle = drawTrips ? pal.tripPinFill : pal.archivePinFill;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(pt.screenX, pt.screenY, Math.max(1.8, r * 0.54), 0, Math.PI * 2);
          ctx.fillStyle = drawTrips ? pal.tripPin : pal.archivePin;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(pt.screenX, pt.screenY, r, 0, Math.PI * 2);
          ctx.strokeStyle = isHovered
            ? pal.hoverRing
            : (drawTrips ? pal.tripPinStroke : pal.archivePinStroke);
          ctx.lineWidth = isHovered ? 1.6 : 1;
          ctx.stroke();
        }
      }

      // Pass 3 & 4: Clean spatial cluster circles with centered tabular count (count >= 3)
      for (let pass = 0; pass < 2; pass += 1) {
        const drawTrips = pass === 1;
        for (let i = 0; i < this._archiveClusters.length; i += 1) {
          const cl = this._archiveClusters[i];
          if (cl.isTripCluster !== drawTrips) continue;
          if (cl.x < -20 || cl.x > w + 20 || cl.y < -20 || cl.y > h + 20) continue;

          const isHovered = this.hoveredPoint && cl.points.indexOf(this.hoveredPoint) !== -1;
          const r = isHovered ? cl.r + 1.4 : cl.r;
          const count = cl.points.length;

          // Soft ambient outer halo
          ctx.beginPath();
          ctx.arc(cl.x, cl.y, r + 2.4, 0, Math.PI * 2);
          ctx.fillStyle = drawTrips ? pal.tripPinFill : pal.archivePinFill;
          ctx.fill();

          // Crisp solid badge fill
          ctx.beginPath();
          ctx.arc(cl.x, cl.y, r, 0, Math.PI * 2);
          ctx.fillStyle = drawTrips ? pal.clusterTripBg : pal.clusterArchiveBg;
          ctx.fill();

          // Crisp rim
          ctx.lineWidth = isHovered ? 1.8 : 1.25;
          ctx.strokeStyle = isHovered
            ? pal.hoverRing
            : (drawTrips ? pal.clusterTripStroke : pal.clusterArchiveStroke);
          ctx.stroke();

          // Centered tabular count
          ctx.font = '600 ' + (count >= 100 ? '8.5px ' : '9.5px ') + pal.fontMono;
          ctx.fillStyle = pal.clusterText;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(count), cl.x, cl.y + 0.5);
        }
      }
    }

    _drawDayArcs(ctx, pal) {
      if (this.dayArcs.length === 0) return;

      const atlas = getGeoAtlas();
      const useAtlasGeodesic = Boolean(atlas && typeof atlas.getGreatCirclePoints === 'function');
      const progress = this._shouldReduceMotion() ? 1 : clamp(this._arcProgress, 0, 1);
      if (progress <= 0.005) return;

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let i = 0; i < this.dayArcs.length; i += 1) {
        const arc = this.dayArcs[i];
        const x1 = arc.from.screenX;
        const y1 = arc.from.screenY;
        const x2 = arc.to.screenX;
        const y2 = arc.to.screenY;
        const chord = Math.hypot(x2 - x1, y2 - y1);
        if (chord < 6) continue;

        let arrowX = 0;
        let arrowY = 0;
        let angle = 0;
        let hasArrow = false;
        let tip = null;

        const dayScreenPts = [];
        if (arc.distKm >= 15 && useAtlasGeodesic) {
          const geoPts = atlas.getGreatCirclePoints(
            arc.from.lat,
            arc.from.lng,
            arc.to.lat,
            arc.to.lng,
            GEODESIC_SEGMENTS,
            progress
          );
          for (let g = 0; g < geoPts.length; g += 1) {
            dayScreenPts.push([
              this._mercToScreenX(lngToMercX(geoPts[g][0])),
              this._mercToScreenY(latToMercY(geoPts[g][1])),
            ]);
          }
          if (dayScreenPts.length > 0) {
            const lastP = dayScreenPts[dayScreenPts.length - 1];
            tip = { x: lastP[0], y: lastP[1] };
          }
          if (progress >= 0.55 && geoPts.length >= 3) {
            const fullPts = atlas.getGreatCirclePoints(
              arc.from.lat,
              arc.from.lng,
              arc.to.lat,
              arc.to.lng,
              GEODESIC_SEGMENTS,
              1
            );
            const midIdx = Math.floor(fullPts.length * 0.5);
            const prevS = fullPts[Math.max(0, midIdx - 1)];
            const nextS = fullPts[Math.min(fullPts.length - 1, midIdx + 1)];
            arrowX = this._mercToScreenX(lngToMercX(fullPts[midIdx][0]));
            arrowY = this._mercToScreenY(latToMercY(fullPts[midIdx][1]));
            angle = Math.atan2(
              this._mercToScreenY(latToMercY(nextS[1])) - this._mercToScreenY(latToMercY(prevS[1])),
              this._mercToScreenX(lngToMercX(nextS[0])) - this._mercToScreenX(lngToMercX(prevS[0]))
            );
            hasArrow = true;
          }
        } else if (arc.samples && arc.samples.length > 2) {
          const maxIdx = Math.max(1, Math.min(arc.samples.length - 1, Math.ceil((arc.samples.length - 1) * progress)));
          for (let s = 0; s <= maxIdx; s += 1) {
            const sx = this._mercToScreenX(arc.samples[s][0]);
            const sy = this._mercToScreenY(arc.samples[s][1]);
            dayScreenPts.push([sx, sy]);
            tip = { x: sx, y: sy };
          }
          if (progress >= 0.55) {
            const midIdx = Math.floor(arc.samples.length * 0.5);
            const prevS = arc.samples[Math.max(0, midIdx - 1)];
            const nextS = arc.samples[Math.min(arc.samples.length - 1, midIdx + 1)];
            arrowX = this._mercToScreenX(arc.samples[midIdx][0]);
            arrowY = this._mercToScreenY(arc.samples[midIdx][1]);
            angle = Math.atan2(
              this._mercToScreenY(nextS[1]) - this._mercToScreenY(prevS[1]),
              this._mercToScreenX(nextS[0]) - this._mercToScreenX(prevS[0])
            );
            hasArrow = true;
          }
        } else {
          // Alternate slight curve curvature on alternating legs so return trips never collide
          const sign = arc.legIndex % 2 === 0 ? 1 : -1;
          const midX = (x1 + x2) * 0.5;
          const midY = (y1 + y2) * 0.5;
          const nx = -(y2 - y1) / chord;
          const ny = (x2 - x1) / chord;
          const lift = Math.min(40, chord * 0.18) * sign;
          const cpx = midX + nx * lift;
          const cpy = midY + ny * lift;
          const steps = 18;
          for (let s = 0; s <= steps; s += 1) {
            const t = (s / steps) * progress;
            const mt = 1 - t;
            const px = mt * mt * x1 + 2 * mt * t * cpx + t * t * x2;
            const py = mt * mt * y1 + 2 * mt * t * cpy + t * t * y2;
            dayScreenPts.push([px, py]);
            tip = { x: px, y: py };
          }

          if (progress >= 0.55) {
            arrowX = 0.25 * x1 + 0.5 * cpx + 0.25 * x2;
            arrowY = 0.25 * y1 + 0.5 * cpy + 0.25 * y2;
            angle = Math.atan2(y2 - y1, x2 - x1);
            hasArrow = true;
          }
        }

        // Tapered great-circle / geodesic active day arc
        this._drawTaperedScreenPolyline(ctx, dayScreenPts, pal.activeArc, pal.activeArcGlow, 2.7, 0.96);

        if (tip && progress < 0.995) {
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(tip.x, tip.y, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = pal.activePin;
          ctx.fill();
        }

        // Crisp directional chevron arrow at leg midpoint
        if (hasArrow && chord >= 26) {
          ctx.setLineDash([]);
          ctx.fillStyle = pal.activePin;
          const headLen = 5.5;
          ctx.beginPath();
          ctx.moveTo(
            arrowX + Math.cos(angle) * headLen,
            arrowY + Math.sin(angle) * headLen
          );
          ctx.lineTo(
            arrowX + Math.cos(angle + 2.45) * headLen,
            arrowY + Math.sin(angle + 2.45) * headLen
          );
          ctx.lineTo(
            arrowX + Math.cos(angle - 2.45) * headLen,
            arrowY + Math.sin(angle - 2.45) * headLen
          );
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }

    _drawDayPins(ctx, pal, w, h) {
      if (this.dayPoints.length === 0) return;

      const isDetailOff = typeof document !== 'undefined' &&
        document.documentElement &&
        document.documentElement.getAttribute('data-detail') === 'off';
      const showNumbers = this.dayPoints.length > 1;
      for (let i = 0; i < this.dayPoints.length; i += 1) {
        const pt = this.dayPoints[i];
        if (pt.screenX < -28 || pt.screenX > w + 28 || pt.screenY < -28 || pt.screenY > h + 28) {
          continue;
        }
        const isHovered = this.hoveredPoint === pt;
        const baseR = showNumbers ? 8.2 : 6.6;
        const r = isHovered ? baseR + 1.4 : baseR;

        // Layer 0: Luminous radial atmospheric city beacon halo (zero ctx.filter)
        if (!isDetailOff) {
          const haloR = r + (isHovered ? 19 : 16);
          const beaconGrad = ctx.createRadialGradient(pt.screenX, pt.screenY, r * 0.5, pt.screenX, pt.screenY, haloR);
          if (pal.isLight) {
            beaconGrad.addColorStop(0, 'rgba(22, 163, 74, 0.24)');
            beaconGrad.addColorStop(0.55, 'rgba(22, 163, 74, 0.08)');
            beaconGrad.addColorStop(1, 'rgba(22, 163, 74, 0)');
          } else {
            beaconGrad.addColorStop(0, 'rgba(52, 211, 153, 0.30)');
            beaconGrad.addColorStop(0.55, 'rgba(52, 211, 153, 0.10)');
            beaconGrad.addColorStop(1, 'rgba(52, 211, 153, 0)');
          }
          ctx.beginPath();
          ctx.arc(pt.screenX, pt.screenY, haloR, 0, Math.PI * 2);
          ctx.fillStyle = beaconGrad;
          ctx.fill();

          // Outer concentric telemetry beacon ring + cardinal ticks
          const outerRingR = r + (isHovered ? 11.5 : 9.8);
          ctx.save();
          ctx.beginPath();
          ctx.arc(pt.screenX, pt.screenY, outerRingR, 0, Math.PI * 2);
          ctx.strokeStyle = pal.isLight ? 'rgba(22, 163, 74, 0.34)' : 'rgba(52, 211, 153, 0.38)';
          ctx.lineWidth = 0.9;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.beginPath();
          const tickIn = outerRingR - 1.5;
          const tickOut = outerRingR + 2.2;
          ctx.moveTo(pt.screenX, pt.screenY - tickIn); ctx.lineTo(pt.screenX, pt.screenY - tickOut);
          ctx.moveTo(pt.screenX, pt.screenY + tickIn); ctx.lineTo(pt.screenX, pt.screenY + tickOut);
          ctx.moveTo(pt.screenX - tickIn, pt.screenY); ctx.lineTo(pt.screenX - tickOut, pt.screenY);
          ctx.moveTo(pt.screenX + tickIn, pt.screenY); ctx.lineTo(pt.screenX + tickOut, pt.screenY);
          ctx.strokeStyle = pal.isLight ? 'rgba(22, 163, 74, 0.48)' : 'rgba(110, 231, 183, 0.56)';
          ctx.lineWidth = 0.95;
          ctx.stroke();
          ctx.restore();
        }

        // Layer 1: Soft ambient inner glow disc
        ctx.beginPath();
        ctx.arc(pt.screenX, pt.screenY, r + 4.8, 0, Math.PI * 2);
        ctx.fillStyle = pal.activePinGlow;
        ctx.fill();

        // Layer 2: Crisp concentric precision ring
        ctx.beginPath();
        ctx.arc(pt.screenX, pt.screenY, r + (isHovered ? 4.2 : 3.4), 0, Math.PI * 2);
        ctx.strokeStyle = isHovered ? pal.hoverRing : pal.activePinRing;
        ctx.lineWidth = isHovered ? 1.4 : 1.1;
        ctx.stroke();

        // Layer 3: Main emerald badge with high-contrast surface rim
        ctx.beginPath();
        ctx.arc(pt.screenX, pt.screenY, r, 0, Math.PI * 2);
        ctx.fillStyle = pal.activePin;
        ctx.fill();

        ctx.lineWidth = isHovered ? 2.0 : 1.4;
        ctx.strokeStyle = isHovered ? pal.hoverRing : pal.activePinCore;
        ctx.stroke();

        // Layer 4: Chronological numeral or soft pinpoint highlight
        if (showNumbers) {
          ctx.font = '600 9.5px ' + pal.fontMono;
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(i + 1), pt.screenX, pt.screenY + 0.5);
        } else {
          ctx.beginPath();
          ctx.arc(pt.screenX, pt.screenY, 2.35, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();

          // Soft pinpoint specular highlight
          ctx.beginPath();
          ctx.arc(pt.screenX - r * 0.28, pt.screenY - r * 0.28, 1.0, 0, Math.PI * 2);
          ctx.fillStyle = pal.activePinSpec;
          ctx.fill();
        }
      }
    }

    _resetCometProgress() {
      this._cometDistPx = 0;
      this._cometRestRemaining = 0;
      this._cometTriggeredPins.clear();
      this._pinPulses = [];
    }

    _getCometArcs() {
      if (this.dayArcs.length > 0) {
        return { arcs: this.dayArcs, isDayRoute: true };
      }
      if (this.archiveArcs.length > 0 && (this.region !== 'day' || this._cometManualT !== null)) {
        return { arcs: this.archiveArcs, isDayRoute: false };
      }
      return null;
    }

    _buildCometPolyline() {
      const track = this._getCometArcs();
      if (!track || !track.arcs.length) return null;

      const atlas = getGeoAtlas();
      const useAtlasGeodesic = Boolean(atlas && typeof atlas.getGreatCirclePoints === 'function');
      const pts = [];
      const pinStops = [];
      let totalPx = 0;

      const appendVertex = (x, y, legId, isTrip, isJump) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (pts.length > 0 && !isJump) {
          const prev = pts[pts.length - 1];
          const seg = Math.hypot(x - prev.x, y - prev.y);
          if (seg < 0.25) return;
          totalPx += seg;
        }
        pts.push({ x, y, cumDist: totalPx, legId, isTrip: Boolean(isTrip), isJump: Boolean(isJump) });
      };

      for (let i = 0; i < track.arcs.length; i += 1) {
        const arc = track.arcs[i];
        const x1 = this._mercToScreenX(arc.from.mx);
        const y1 = this._mercToScreenY(arc.from.my);
        const x2 = this._mercToScreenX(arc.to.mx);
        const y2 = this._mercToScreenY(arc.to.my);
        const chord = Math.hypot(x2 - x1, y2 - y1);
        if (chord < 6) continue;

        const legId = i;
        const isTripLeg = Boolean(arc.isTripArc || arc.distKm >= 30 || arc.from.isTrip || arc.to.isTrip);
        const isJump =
          pts.length > 0 &&
          Math.hypot(x1 - pts[pts.length - 1].x, y1 - pts[pts.length - 1].y) > 4;

        const legStartDist = totalPx;
        if (pinStops.length === 0 || isJump) {
          pinStops.push({
            key: 'start:' + i + ':' + arc.from.lat.toFixed(4) + ',' + arc.from.lng.toFixed(4),
            distPx: legStartDist,
            point: arc.from,
          });
        }

        const useGeo =
          track.isDayRoute
            ? (arc.distKm >= 60 && useAtlasGeodesic)
            : useAtlasGeodesic;

        if (useGeo) {
          const geoPts = atlas.getGreatCirclePoints(
            arc.from.lat,
            arc.from.lng,
            arc.to.lat,
            arc.to.lng,
            GEODESIC_SEGMENTS,
            1
          );
          for (let s = 0; s < geoPts.length; s += 1) {
            const sx = this._mercToScreenX(lngToMercX(geoPts[s][0]));
            const sy = this._mercToScreenY(latToMercY(geoPts[s][1]));
            const wrapBreak = s > 0 && Math.abs(geoPts[s][0] - geoPts[s - 1][0]) > 180;
            appendVertex(sx, sy, legId, isTripLeg, (s === 0 && isJump) || wrapBreak);
          }
        } else if (arc.samples && arc.samples.length > 2) {
          for (let s = 0; s < arc.samples.length; s += 1) {
            const sx = this._mercToScreenX(arc.samples[s][0]);
            const sy = this._mercToScreenY(arc.samples[s][1]);
            appendVertex(sx, sy, legId, isTripLeg, s === 0 && isJump);
          }
        } else {
          const sign = track.isDayRoute ? (arc.legIndex % 2 === 0 ? 1 : -1) : 1;
          const midX = (x1 + x2) * 0.5;
          const midY = (y1 + y2) * 0.5;
          const nx = -(y2 - y1) / chord;
          const ny = (x2 - x1) / chord;
          const lift = (track.isDayRoute ? Math.min(40, chord * 0.18) : Math.min(44, chord * 0.16)) * sign;
          const cpx = midX + nx * lift;
          const cpy = midY + ny * lift;
          const steps = 22;
          for (let s = 0; s <= steps; s += 1) {
            const t = s / steps;
            const omt = 1 - t;
            const sx = omt * omt * x1 + 2 * omt * t * cpx + t * t * x2;
            const sy = omt * omt * y1 + 2 * omt * t * cpy + t * t * y2;
            appendVertex(sx, sy, legId, isTripLeg, s === 0 && isJump);
          }
        }

        pinStops.push({
          key: 'end:' + i + ':' + arc.to.lat.toFixed(4) + ',' + arc.to.lng.toFixed(4),
          distPx: totalPx,
          point: arc.to,
        });
      }

      if (pts.length < 2 || totalPx < 1) return null;
      return { pts, pinStops, totalPx, isDayRoute: track.isDayRoute };
    }

    _samplePolylineAtDist(poly, distPx) {
      const pts = poly.pts;
      if (!pts.length) return null;
      const d = clamp(distPx, 0, poly.totalPx);
      if (d <= 0) {
        return { x: pts[0].x, y: pts[0].y, legId: pts[0].legId, isTrip: pts[0].isTrip };
      }
      if (d >= poly.totalPx) {
        const last = pts[pts.length - 1];
        return { x: last.x, y: last.y, legId: last.legId, isTrip: last.isTrip };
      }

      let lo = 0;
      let hi = pts.length - 1;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].cumDist <= d) lo = mid;
        else hi = mid;
      }

      const a = pts[lo];
      const b = pts[hi];
      if (b.isJump || b.cumDist <= a.cumDist) {
        return { x: b.x, y: b.y, legId: b.legId, isTrip: b.isTrip };
      }
      const span = b.cumDist - a.cumDist;
      const u = clamp((d - a.cumDist) / span, 0, 1);
      return {
        x: a.x + (b.x - a.x) * u,
        y: a.y + (b.y - a.y) * u,
        legId: b.legId,
        isTrip: b.isTrip,
      };
    }

    _triggerPinPulse(point, now) {
      if (!point || this._shouldReduceMotion()) return;
      const ts = Number.isFinite(now) ? now : nowMs();
      for (let i = 0; i < this._pinPulses.length; i += 1) {
        if (this._pinPulses[i].point === point) {
          this._pinPulses[i].startTs = ts;
          return;
        }
      }
      this._pinPulses.push({
        point,
        startTs: ts,
        isTrip: Boolean(point.isTrip),
      });
    }

    _stepComet(dt, now) {
      if (this._arcAnim && this._arcProgress < 0.92) {
        return;
      }
      const poly = this._buildCometPolyline();
      if (!poly || poly.totalPx < 12) return;

      if (this._cometRestRemaining > 0) {
        this._cometRestRemaining -= dt;
        if (this._cometRestRemaining <= 0) {
          this._cometRestRemaining = 0;
          this._cometDistPx = 0;
          this._cometTriggeredPins.clear();
        }
        return;
      }

      const prevDist = this._cometDistPx;
      const nextDist = prevDist + COMET_SPEED_PX_S * dt;

      for (let i = 0; i < poly.pinStops.length; i += 1) {
        const stop = poly.pinStops[i];
        if (this._cometTriggeredPins.has(stop.key)) continue;
        const crossed =
          (prevDist === 0 && stop.distPx === 0 && nextDist > 0) ||
          (stop.distPx > prevDist && stop.distPx <= nextDist);
        if (crossed) {
          this._cometTriggeredPins.add(stop.key);
          this._triggerPinPulse(stop.point, now);
        }
      }

      if (nextDist >= poly.totalPx) {
        this._cometDistPx = poly.totalPx;
        const lastStop = poly.pinStops[poly.pinStops.length - 1];
        if (lastStop && !this._cometTriggeredPins.has(lastStop.key)) {
          this._cometTriggeredPins.add(lastStop.key);
          this._triggerPinPulse(lastStop.point, now);
        }
        this._cometRestRemaining = COMET_REST_S;
      } else {
        this._cometDistPx = nextDist;
      }
    }

    _drawComet(ctx, pal) {
      if (this._shouldReduceMotion()) return;
      if (this._arcAnim && this._arcProgress < 0.92) return;
      const poly = this._buildCometPolyline();
      if (!poly || poly.totalPx < 12) return;

      let headDist;
      let restFade = 1;
      if (this._cometManualT !== null) {
        headDist = clamp(this._cometManualT, 0, 1) * poly.totalPx;
      } else {
        headDist = clamp(this._cometDistPx, 0, poly.totalPx);
        if (this._cometRestRemaining > 0) {
          const restElapsed = COMET_REST_S - this._cometRestRemaining;
          restFade = clamp(1 - restElapsed / 0.28, 0, 1);
          if (restFade <= 0.01) return;
        }
      }

      const head = this._samplePolylineAtDist(poly, headDist);
      if (!head) return;

      const tailLen = Math.min(COMET_TAIL_PX, headDist);
      const emerald = pal.isLight ? [22, 163, 74] : [70, 167, 88];
      const amber = pal.isLight ? [217, 119, 6] : [245, 166, 35];
      const coreRgb = head.isTrip ? amber : emerald;

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Smooth tapering 60px directional tail (emerald -> warm amber near tip)
      if (tailLen >= 2) {
        const segCount = 16;
        let prevSample = null;
        for (let s = 0; s <= segCount; s += 1) {
          const u = s / segCount; // 0 = tail end, 1 = comet head
          const d = headDist - tailLen * (1 - u);
          const sample = this._samplePolylineAtDist(poly, d);
          if (sample && prevSample && sample.legId === prevSample.legId) {
            const blend = head.isTrip ? (0.35 + 0.65 * u) : (u * u * 0.72);
            const cr = Math.round(emerald[0] + (amber[0] - emerald[0]) * blend);
            const cg = Math.round(emerald[1] + (amber[1] - emerald[1]) * blend);
            const cb = Math.round(emerald[2] + (amber[2] - emerald[2]) * blend);
            const segAlpha = clamp(u * u * 0.88 * restFade, 0, 1);
            ctx.beginPath();
            ctx.moveTo(prevSample.x, prevSample.y);
            ctx.lineTo(sample.x, sample.y);
            ctx.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + segAlpha.toFixed(3) + ')';
            ctx.lineWidth = 0.7 + u * 2.9;
            ctx.stroke();
          }
          prevSample = sample;
        }
      }

      // Luminous concentric head halo + 4px bright core (pure alpha circles)
      ctx.beginPath();
      ctx.arc(head.x, head.y, COMET_CORE_R + 3.6, 0, Math.PI * 2);
      ctx.fillStyle =
        'rgba(' + coreRgb[0] + ',' + coreRgb[1] + ',' + coreRgb[2] + ',' + (0.22 * restFade).toFixed(3) + ')';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(head.x, head.y, COMET_CORE_R, 0, Math.PI * 2);
      ctx.fillStyle =
        'rgba(' + amber[0] + ',' + amber[1] + ',' + amber[2] + ',' + (0.94 * restFade).toFixed(3) + ')';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(head.x, head.y, COMET_CORE_R * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + (0.96 * restFade).toFixed(3) + ')';
      ctx.fill();

      ctx.restore();
    }

    _drawPinPulses(ctx, pal) {
      if (this._shouldReduceMotion() || this._pinPulses.length === 0) return;
      const now = nowMs();
      const showNumbers = this.dayPoints.length > 1;

      ctx.save();
      for (let i = 0; i < this._pinPulses.length; i += 1) {
        const pulse = this._pinPulses[i];
        const elapsed = now - pulse.startTs;
        if (elapsed < 0 || elapsed >= PIN_PULSE_TOTAL_MS) continue;
        const pt = pulse.point;
        if (!pt) continue;
        const px = this._mercToScreenX(pt.mx);
        const py = this._mercToScreenY(pt.my);
        const baseR = pt.isActiveDay ? (showNumbers ? 8.2 : 6.6) : (pt.isTrip ? 4.4 : 3.2);

        let ringR;
        let alpha;
        let lw;
        if (elapsed <= PIN_PULSE_PEAK_MS) {
          const u = easeOutCubic(elapsed / PIN_PULSE_PEAK_MS);
          ringR = baseR + 2.5 + u * 4.5;
          alpha = 0.25 + u * 0.67;
          lw = 1.9;
        } else {
          const u = easeOutCubic((elapsed - PIN_PULSE_PEAK_MS) / (PIN_PULSE_TOTAL_MS - PIN_PULSE_PEAK_MS));
          ringR = baseR + 7.0 + u * 11.5;
          alpha = 0.92 * (1 - u);
          lw = 1.8 - u * 1.1;
        }

        const rgb = pulse.isTrip
          ? (pal.isLight ? [217, 119, 6] : [245, 166, 35])
          : (pal.isLight ? [22, 163, 74] : [70, 167, 88]);

        ctx.beginPath();
        ctx.arc(px, py, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + clamp(alpha, 0, 1).toFixed(3) + ')';
        ctx.lineWidth = Math.max(0.65, lw);
        ctx.stroke();
      }
      ctx.restore();
    }

    _planForegroundPills(ctx, pal, w, h, spanLon, showCompass) {
      const pills = [];
      const placed = [];
      const placedPillRects = [];
      const padMargin = 4;

      // Protect all rendered spatial cluster circles with >= 14px horizontal clearance
      // BEFORE placing any place-label pill (hovered, active day, or archive trip).
      const CLUSTER_H_CLEARANCE = 14;
      const CLUSTER_V_CLEARANCE = 10;
      const clusterObstacles = [];
      for (let i = 0; i < this._archiveClusters.length; i += 1) {
        const cl = this._archiveClusters[i];
        if (cl.x < -24 || cl.x > w + 24 || cl.y < -24 || cl.y > h + 24) continue;
        clusterObstacles.push({
          x1: cl.x - (cl.r + CLUSTER_H_CLEARANCE),
          y1: cl.y - (cl.r + CLUSTER_V_CLEARANCE),
          x2: cl.x + (cl.r + CLUSTER_H_CLEARANCE),
          y2: cl.y + (cl.r + CLUSTER_V_CLEARANCE),
          cluster: cl,
        });
      }

      // Protect rendered active day pins so unrelated pills never obscure numbered badges
      const dayPinObstacles = [];
      for (let i = 0; i < this.dayPoints.length; i += 1) {
        const dp = this.dayPoints[i];
        if (dp.screenX < -24 || dp.screenX > w + 24 || dp.screenY < -24 || dp.screenY > h + 24) continue;
        dayPinObstacles.push({
          x1: dp.screenX - 11,
          y1: dp.screenY - 11,
          x2: dp.screenX + 11,
          y2: dp.screenY + 11,
          point: dp,
        });
      }

      const hudObstacles = showCompass
        ? [{ x1: 0, y1: Math.max(0, h - 62), x2: 56, y2: h }]
        : [];

      const findContainingCluster = (pt) => {
        if (!pt) return null;
        for (let i = 0; i < this._archiveClusters.length; i += 1) {
          const cl = this._archiveClusters[i];
          if (cl.points.indexOf(pt) !== -1) return cl;
        }
        for (let i = 0; i < this._archiveClusters.length; i += 1) {
          const cl = this._archiveClusters[i];
          if (Math.hypot(pt.screenX - cl.x, pt.screenY - cl.y) <= cl.r + 6) return cl;
        }
        return null;
      };

      // Compute sparsity budget so single/sparse labels (e.g. Garmisch-Partenkirchen) render in full
      const activeDayLabelClearance = spanLon > 40 ? 70 : 24;
      let visibleDayCount = 0;
      for (let i = 0; i < this.dayPoints.length; i += 1) {
        const dp = this.dayPoints[i];
        if (dp.screenX >= -10 && dp.screenX <= w + 10 && dp.screenY >= -10 && dp.screenY <= h + 10) {
          visibleDayCount += 1;
        }
      }
      let visibleTripCount = 0;
      const countedTripCoords = [];
      for (let i = this.points.length - 1; i >= 0; i -= 1) {
        const pt = this.points[i];
        if (!pt.isTrip || this._isExcludedArchivePoint(pt)) continue;
        if (pt.screenX < 16 || pt.screenX > w - 16 || pt.screenY < 42 || pt.screenY > h - 38) continue;
        let nearActive = false;
        for (let d = 0; d < this.dayPoints.length; d += 1) {
          const dp = this.dayPoints[d];
          if (Math.hypot(pt.screenX - dp.screenX, pt.screenY - dp.screenY) < activeDayLabelClearance) {
            nearActive = true;
            break;
          }
        }
        if (nearActive) continue;
        let dup = false;
        for (let k = 0; k < countedTripCoords.length; k += 1) {
          if (Math.hypot(pt.screenX - countedTripCoords[k].x, pt.screenY - countedTripCoords[k].y) < 34) {
            dup = true;
            break;
          }
        }
        if (!dup) {
          countedTripCoords.push({ x: pt.screenX, y: pt.screenY });
          visibleTripCount += 1;
        }
      }
      const isSparse =
        (visibleDayCount + visibleTripCount <= 4) &&
        (this.region === 'day' || this.region === 'europe' || spanLon <= 40);
      const dayLabelMaxLen = (isSparse || visibleDayCount === 1) ? 28 : 22;
      const tripLabelMaxLen = isSparse ? 28 : 20;

      const tryPlacePill = (x, y, text, subText, accentColor, pinRadius, force, ownerCluster, ownerPoint) => {
        ctx.font = '500 10.5px ' + pal.fontSans;
        const mainW = ctx.measureText(text).width;
        let subW = 0;
        if (subText) {
          ctx.font = '400 9.5px ' + pal.fontMono;
          subW = ctx.measureText(subText).width + 6;
        }
        const padX = 7;
        const boxW = Math.ceil(mainW + subW + padX * 2);
        const boxH = 20;
        const anchorX = ownerCluster ? ownerCluster.x : x;
        const anchorY = ownerCluster ? ownerCluster.y : y;
        const horizGap = ownerCluster
          ? Math.max(pinRadius + CLUSTER_H_CLEARANCE, ownerCluster.r + CLUSTER_H_CLEARANCE + 2)
          : (pinRadius + 7);
        const vertGap = ownerCluster
          ? Math.max(pinRadius + CLUSTER_V_CLEARANCE, ownerCluster.r + CLUSTER_V_CLEARANCE + 2)
          : (pinRadius + 7);
        const minY = 42;
        const maxY = Math.max(minY, h - boxH - 38);

        // Try 8 clean anchor positions (right/left/above/below + diagonals; prefer below near top HUD)
        const candidates = anchorY < 68
          ? [
            { bx: anchorX + horizGap, by: anchorY - boxH * 0.5 },
            { bx: anchorX - horizGap - boxW, by: anchorY - boxH * 0.5 },
            { bx: anchorX - boxW * 0.5, by: anchorY + vertGap },
            { bx: anchorX + horizGap, by: anchorY + vertGap * 0.65 },
            { bx: anchorX - horizGap - boxW, by: anchorY + vertGap * 0.65 },
            { bx: anchorX - boxW * 0.5, by: anchorY - vertGap - boxH },
            { bx: anchorX + horizGap, by: anchorY - vertGap * 0.65 - boxH },
            { bx: anchorX - horizGap - boxW, by: anchorY - vertGap * 0.65 - boxH },
          ]
          : [
            { bx: anchorX + horizGap, by: anchorY - boxH * 0.5 },
            { bx: anchorX - horizGap - boxW, by: anchorY - boxH * 0.5 },
            { bx: anchorX - boxW * 0.5, by: anchorY - vertGap - boxH },
            { bx: anchorX - boxW * 0.5, by: anchorY + vertGap },
            { bx: anchorX + horizGap, by: anchorY - vertGap * 0.65 - boxH },
            { bx: anchorX - horizGap - boxW, by: anchorY - vertGap * 0.65 - boxH },
            { bx: anchorX + horizGap, by: anchorY + vertGap * 0.65 },
            { bx: anchorX - horizGap - boxW, by: anchorY + vertGap * 0.65 },
          ];

        const overlapsCluster = (exactRect) => {
          for (let j = 0; j < clusterObstacles.length; j += 1) {
            if (rectsOverlap(exactRect, clusterObstacles[j])) return true;
          }
          return false;
        };

        const overlapsOtherDayPin = (exactRect) => {
          for (let j = 0; j < dayPinObstacles.length; j += 1) {
            if (dayPinObstacles[j].point === ownerPoint) continue;
            if (rectsOverlap(exactRect, dayPinObstacles[j])) return true;
          }
          return false;
        };

        const overlapsHud = (exactRect) => {
          for (let j = 0; j < hudObstacles.length; j += 1) {
            if (rectsOverlap(exactRect, hudObstacles[j])) return true;
          }
          return false;
        };

        const evalCandidates = (checkPlacedPills) => {
          for (let c = 0; c < candidates.length; c += 1) {
            const cand = candidates[c];
            const bx = clamp(cand.bx, 6, Math.max(6, w - boxW - 6));
            const by = clamp(cand.by, minY, maxY);
            const exactRect = { x1: bx, y1: by, x2: bx + boxW, y2: by + boxH };
            const rect = {
              x1: bx - padMargin,
              y1: by - padMargin,
              x2: bx + boxW + padMargin,
              y2: by + boxH + padMargin,
            };
            if (overlapsCluster(exactRect) || overlapsOtherDayPin(exactRect) || overlapsHud(exactRect)) continue;
            if (checkPlacedPills) {
              let collides = false;
              for (let j = 0; j < placed.length; j += 1) {
                if (rectsOverlap(rect, placed[j])) {
                  collides = true;
                  break;
                }
              }
              if (collides) continue;
            }
            return { bx, by, rect, exactRect };
          }
          return null;
        };

        let chosen = evalCandidates(true);

        if (!chosen && force) {
          // Even for forced hover labels, prefer a slot that still clears cluster circles
          chosen = evalCandidates(false);
        }

        if (!chosen && force) {
          const bx = clamp(anchorX + horizGap, 6, Math.max(6, w - boxW - 6));
          const by = clamp(anchorY - boxH * 0.5, minY, maxY);
          chosen = {
            bx,
            by,
            exactRect: { x1: bx, y1: by, x2: bx + boxW, y2: by + boxH },
            rect: {
              x1: bx - padMargin,
              y1: by - padMargin,
              x2: bx + boxW + padMargin,
              y2: by + boxH + padMargin,
            },
          };
        }

        if (!chosen) return false;
        placed.push(chosen.rect);
        placedPillRects.push(chosen.exactRect);
        pills.push({
          bx: chosen.bx,
          by: chosen.by,
          boxW,
          boxH,
          padX,
          mainW,
          text,
          subText,
          accentColor,
        });
        return true;
      };

      // Priority 1: Hovered pin label
      if (this.hoveredPoint) {
        const hp = this.hoveredPoint;
        const hpCluster = hp.isActiveDay ? null : findContainingCluster(hp);
        const accent = hp.isActiveDay
          ? pal.activePin
          : (hp.isTrip ? pal.tripPin : pal.archivePin);
        const sub = hp.day ? hp.day.slice(5) : '';
        tryPlacePill(
          hp.screenX,
          hp.screenY,
          truncateLabel(hp.label, 28),
          sub,
          accent,
          hp.isActiveDay ? 9 : (hpCluster ? hpCluster.r : 6),
          true,
          hpCluster,
          hp
        );
      }

      // Priority 2: Active day stops (spatially deduplicated when zoomed out)
      const labeledDayCoords = [];
      const dayClusterMinDist = spanLon > 4 ? 42 : 0;
      for (let i = 0; i < this.dayPoints.length; i += 1) {
        const pt = this.dayPoints[i];
        if (pt === this.hoveredPoint) continue;
        if (pt.screenX < -10 || pt.screenX > w + 10 || pt.screenY < -10 || pt.screenY > h + 10) {
          continue;
        }
        if (dayClusterMinDist > 0) {
          let clustered = false;
          for (let k = 0; k < labeledDayCoords.length; k += 1) {
            if (Math.hypot(pt.screenX - labeledDayCoords[k].x, pt.screenY - labeledDayCoords[k].y) < dayClusterMinDist) {
              clustered = true;
              break;
            }
          }
          if (clustered) continue;
        }
        let clusterCount = 0;
        if (dayClusterMinDist > 0) {
          for (let j = 0; j < this.dayPoints.length; j += 1) {
            if (j === i) continue;
            if (Math.hypot(pt.screenX - this.dayPoints[j].screenX, pt.screenY - this.dayPoints[j].screenY) < dayClusterMinDist) {
              clusterCount += 1;
            }
          }
        }
        const prefix = this.dayPoints.length > 1 && dayClusterMinDist === 0 ? String(i + 1) + '. ' : '';
        const suffix = clusterCount > 0 ? ' +' + clusterCount : '';
        if (
          tryPlacePill(
            pt.screenX,
            pt.screenY,
            prefix + truncateLabel(pt.label, dayLabelMaxLen),
            suffix,
            pal.activePin,
            9,
            false,
            null,
            pt
          )
        ) {
          labeledDayCoords.push({ x: pt.screenX, y: pt.screenY });
        }
      }

      // Priority 3: Distinct away/trip clusters from archive (excluding active day & wide-zoom overlaps)
      const labeledTripCoords = [];
      for (let i = this.points.length - 1; i >= 0; i -= 1) {
        const pt = this.points[i];
        if (!pt.isTrip || pt === this.hoveredPoint) continue;
        if (this._isExcludedArchivePoint(pt)) continue;
        if (pt.screenX < 16 || pt.screenX > w - 16 || pt.screenY < 42 || pt.screenY > h - 38) {
          continue;
        }
        let nearActiveDay = false;
        for (let d = 0; d < this.dayPoints.length; d += 1) {
          const dp = this.dayPoints[d];
          if (Math.hypot(pt.screenX - dp.screenX, pt.screenY - dp.screenY) < activeDayLabelClearance) {
            nearActiveDay = true;
            break;
          }
        }
        if (nearActiveDay) continue;
        let tooClose = false;
        for (let k = 0; k < labeledTripCoords.length; k += 1) {
          const prev = labeledTripCoords[k];
          if (Math.hypot(pt.screenX - prev.x, pt.screenY - prev.y) < 34) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;
        const ptCluster = findContainingCluster(pt);
        if (
          tryPlacePill(
            pt.screenX,
            pt.screenY,
            truncateLabel(pt.label, tripLabelMaxLen),
            '',
            pal.pillBorder,
            ptCluster ? ptCluster.r : 5,
            false,
            ptCluster,
            pt
          )
        ) {
          labeledTripCoords.push({ x: pt.screenX, y: pt.screenY });
        }
      }

      return { pills, placed, placedPillRects, dayPinObstacles };
    }

    _renderForegroundPills(ctx, pal, pills) {
      if (!pills || pills.length === 0) return;
      for (let i = 0; i < pills.length; i += 1) {
        const p = pills[i];
        ctx.save();
        ctx.beginPath();
        roundRectPath(ctx, p.bx, p.by, p.boxW, p.boxH, 5);
        ctx.fillStyle = pal.pillBg;
        ctx.fill();
        ctx.strokeStyle = p.accentColor || pal.pillBorder;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Crisp 1px top-edge specular catchlight
        ctx.beginPath();
        ctx.moveTo(p.bx + 4.5, p.by + 0.75);
        ctx.lineTo(p.bx + p.boxW - 4.5, p.by + 0.75);
        ctx.strokeStyle = pal.isLight ? 'rgba(255, 255, 255, 0.90)' : 'rgba(255, 255, 255, 0.18)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.font = '500 10.5px ' + pal.fontSans;
        ctx.fillStyle = pal.pillText;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.text, p.bx + p.padX, p.by + p.boxH * 0.5 + 0.5);

        if (p.subText) {
          ctx.font = '400 9.5px ' + pal.fontMono;
          ctx.fillStyle = pal.pillSubText;
          ctx.fillText(p.subText, p.bx + p.padX + p.mainW + 6, p.by + p.boxH * 0.5 + 0.5);
        }
        ctx.restore();
      }
    }

    _drawFallbackContextLabels(ctx, pal, w, h, spanLon, pillPlan) {
      const placed = pillPlan.placed.slice();

      // Protect cluster badges and active day pins from subtle background anchor/context labels
      for (let i = 0; i < this._archiveClusters.length; i += 1) {
        const cl = this._archiveClusters[i];
        placed.push({
          x1: cl.x - cl.r - 6,
          y1: cl.y - cl.r - 6,
          x2: cl.x + cl.r + 6,
          y2: cl.y + cl.r + 6,
        });
      }
      for (let i = 0; i < pillPlan.dayPinObstacles.length; i += 1) {
        placed.push(pillPlan.dayPinObstacles[i]);
      }

      // Priority 4: Close-up London anchor labels when zoomed in close (spanLon < 1.2)
      if (spanLon < 1.2) {
        const fade = clamp((1.2 - spanLon) / 0.45, 0.25, 1);
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.font = '400 9.5px ' + pal.fontMono;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        for (let i = 0; i < PROJECTED_LONDON_ANCHORS.length; i += 1) {
          const a = PROJECTED_LONDON_ANCHORS[i];
          const sx = this._mercToScreenX(a.mx);
          const sy = this._mercToScreenY(a.my);
          if (sx < 14 || sx > w - 60 || sy < 46 || sy > h - 38) continue;

          const tw = ctx.measureText(a.label).width;
          const rect = {
            x1: sx - 4,
            y1: sy - 8,
            x2: sx + tw + 12,
            y2: sy + 8,
          };
          let collides = false;
          for (let j = 0; j < placed.length; j += 1) {
            if (rectsOverlap(rect, placed[j])) {
              collides = true;
              break;
            }
          }
          if (collides) continue;
          placed.push(rect);

          ctx.beginPath();
          ctx.arc(sx, sy, 2, 0, Math.PI * 2);
          ctx.fillStyle = pal.londonAnchorDot;
          ctx.fill();

          ctx.fillStyle = pal.londonAnchorText;
          ctx.fillText(a.label, sx + 6, sy);
        }
        ctx.restore();
      }

      // Priority 5: Subtle regional geographic context labels
      ctx.save();
      ctx.font = '500 9px ' + pal.fontMono;
      ctx.fillStyle = pal.contextLabel;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < PROJECTED_CONTEXT_LABELS.length; i += 1) {
        const c = PROJECTED_CONTEXT_LABELS[i];
        if (spanLon < c.minSpan || spanLon > c.maxSpan) continue;
        const sx = this._mercToScreenX(c.mx);
        const sy = this._mercToScreenY(c.my);
        if (sx < 34 || sx > w - 34 || sy < 46 || sy > h - 38) continue;

        const tw = ctx.measureText(c.label).width;
        const rect = {
          x1: sx - tw * 0.5 - 6,
          y1: sy - 8,
          x2: sx + tw * 0.5 + 6,
          y2: sy + 8,
        };
        let collides = false;
        for (let j = 0; j < placed.length; j += 1) {
          if (rectsOverlap(rect, placed[j])) {
            collides = true;
            break;
          }
        }
        if (collides) continue;
        placed.push(rect);
        ctx.fillText(c.label, sx, sy);
      }
      ctx.restore();
    }

    _drawScaleBar(ctx, pal, w, h, hasBottomLeftCompass) {
      // Hide floating scale bar on narrow mobile canvases (< 480px) so it never floats over coastlines/arcs
      if (w < 480 || h < 120) return;

      const centerLat = clamp(mercYToLat(this.cam.cy), -75, 75);
      const metersPerWorld = 40075016.686 * Math.cos(centerLat * DEG_TO_RAD);
      const metersPerPx = metersPerWorld / Math.max(1, this.cam.scale);
      const targetMeters = metersPerPx * 76;

      const niceSteps = [
        100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000,
        100000, 200000, 500000, 1000000, 2000000, 5000000,
      ];
      let chosen = niceSteps[0];
      for (let i = 0; i < niceSteps.length; i += 1) {
        if (niceSteps[i] <= targetMeters) {
          chosen = niceSteps[i];
        } else {
          break;
        }
      }

      const barPx = clamp(chosen / metersPerPx, 28, 110);
      const label = chosen >= 1000 ? (chosen / 1000) + ' km' : chosen + ' m';

      ctx.save();
      ctx.strokeStyle = pal.scaleBarLine;
      ctx.lineWidth = 1.2;
      ctx.font = '400 9.5px ' + pal.fontMono;
      ctx.fillStyle = pal.scaleBarText;

      const x0 = hasBottomLeftCompass ? 56 : 12;
      const y0 = h - 14;
      ctx.beginPath();
      ctx.moveTo(x0, y0 - 4);
      ctx.lineTo(x0, y0);
      ctx.lineTo(x0 + barPx, y0);
      ctx.lineTo(x0 + barPx, y0 - 4);
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, x0 + 2, y0 - 4);
      ctx.restore();
    }
  }

  // Export projection & presets metadata for deterministic testing if inspected
  KizukiReplayMap.REGION_PRESETS = REGION_PRESETS;
  KizukiReplayMap.project = function project(lat, lng) {
    return {
      x: lngToMercX(lng),
      y: latToMercY(lat),
    };
  };

  if (typeof global !== 'undefined') global.KizukiReplayMap = KizukiReplayMap;
  if (typeof module !== 'undefined' && module.exports) module.exports = KizukiReplayMap;
})(typeof window !== 'undefined' ? window : globalThis);
