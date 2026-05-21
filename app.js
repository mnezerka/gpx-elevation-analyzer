// ─── Constants ────────────────────────────────────────────────────────────────
const SMOOTH_WINDOW = 7;          // moving-average half-window (each side)
const PROMINENCE_M  = 15;         // min prominence (m) to count as a hill
const MIN_CLIMB_M   = 10;         // min climb height to display
const GRADE = { easy: 4, moderate: 8, hard: 12 };

const MAPY_API_KEY = 'XuWC4G9t0QFM3t-Ra5iKyxc54dal-3wsHFNTGsI04Ew';

const TILE_PROVIDERS = {
  'osm': {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { attribution: '© OpenStreetMap contributors', maxZoom: 19 },
  },
  'mapy-basic': {
    url: `https://api.mapy.cz/v1/maptiles/basic/256/{z}/{x}/{y}?apikey=${MAPY_API_KEY}`,
    options: { attribution: '© <a href="https://mapy.com">Mapy.com</a>', maxZoom: 19 },
  },
  'mapy-outdoor': {
    url: `https://api.mapy.cz/v1/maptiles/outdoor/256/{z}/{x}/{y}?apikey=${MAPY_API_KEY}`,
    options: { attribution: '© <a href="https://mapy.com">Mapy.com</a>', maxZoom: 19 },
  },
  'mapy-aerial': {
    url: `https://api.mapy.cz/v1/maptiles/aerial/256/{z}/{x}/{y}?apikey=${MAPY_API_KEY}`,
    options: { attribution: '© <a href="https://mapy.com">Mapy.com</a>', maxZoom: 20 },
  },
};

// ─── Utility: Haversine distance (km) ─────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ─── Moving average smoothing ─────────────────────────────────────────────────
function smooth(arr, w) {
  return arr.map((_, i) => {
    const lo = Math.max(0, i - w), hi = Math.min(arr.length - 1, i + w);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += arr[j];
    return s / (hi - lo + 1);
  });
}

// ─── Parse GPX ────────────────────────────────────────────────────────────────
function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML in GPX file.');
  const trkpts = Array.from(doc.querySelectorAll('trkpt'));
  if (!trkpts.length) throw new Error('No track points found in GPX file.');

  const pts = [];
  let cumDist = 0;
  trkpts.forEach((pt, i) => {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    const eleEl = pt.querySelector('ele');
    const ele = eleEl ? parseFloat(eleEl.textContent) : null;
    if (isNaN(lat) || isNaN(lon)) return;
    if (i > 0) cumDist += haversine(pts[pts.length-1].lat, pts[pts.length-1].lon, lat, lon);
    pts.push({ lat, lon, ele, dist: cumDist });
  });

  // Fill missing elevation by linear interpolation
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].ele == null) {
      let prev = i - 1, next = i + 1;
      while (next < pts.length && pts[next].ele == null) next++;
      if (prev >= 0 && next < pts.length) {
        const t = (pts[i].dist - pts[prev].dist) / (pts[next].dist - pts[prev].dist);
        pts[i].ele = pts[prev].ele + t * (pts[next].ele - pts[prev].ele);
      } else if (prev >= 0) pts[i].ele = pts[prev].ele;
      else if (next < pts.length) pts[i].ele = pts[next].ele;
      else pts[i].ele = 0;
    }
  }
  return pts;
}

// ─── Gradient per segment ─────────────────────────────────────────────────────
function computeGradients(pts) {
  return pts.map((p, i) => {
    if (i === 0) return 0;
    const dDist = (pts[i].dist - pts[i-1].dist) * 1000; // m
    const dEle  = pts[i].ele - pts[i-1].ele;
    return dDist > 0.1 ? (dEle / dDist) * 100 : 0;
  });
}

// ─── Hill detection ────────────────────────────────────────────────────────────
function detectHills(pts, smoothed) {
  const n = smoothed.length;

  // Find all local maxima / minima with prominence
  const findExtrema = () => {
    const peaks = [], valleys = [];
    for (let i = 1; i < n - 1; i++) {
      if (smoothed[i] >= smoothed[i-1] && smoothed[i] >= smoothed[i+1]) peaks.push(i);
      if (smoothed[i] <= smoothed[i-1] && smoothed[i] <= smoothed[i+1]) valleys.push(i);
    }
    return { peaks, valleys };
  };

  const { peaks, valleys } = findExtrema();

  // For each peak, find the two surrounding valleys (or endpoints)
  const hills = [];
  peaks.forEach((peakIdx, k) => {
    // Nearest valley before peak
    let startIdx = 0;
    for (let j = valleys.length - 1; j >= 0; j--) {
      if (valleys[j] < peakIdx) { startIdx = valleys[j]; break; }
    }
    // Nearest valley after peak
    let endIdx = n - 1;
    for (let j = 0; j < valleys.length; j++) {
      if (valleys[j] > peakIdx) { endIdx = valleys[j]; break; }
    }

    const peakEle = smoothed[peakIdx];
    const baseEle = Math.max(smoothed[startIdx], smoothed[endIdx]);
    const climb   = peakEle - Math.min(smoothed[startIdx], smoothed[endIdx]);

    if (climb < PROMINENCE_M) return;
    if (climb < MIN_CLIMB_M) return;

    // Compute stats using raw elevations from startIdx→peakIdx
    const climbDist = (pts[peakIdx].dist - pts[startIdx].dist);
    const avgGrade  = climbDist > 0 ? (climb / (climbDist * 1000)) * 100 : 0;

    // Max gradient over consecutive points
    let maxGrade = 0;
    for (let i = startIdx + 1; i <= peakIdx; i++) {
      const dDist = (pts[i].dist - pts[i-1].dist) * 1000;
      const dEle  = pts[i].ele - pts[i-1].ele;
      if (dDist > 0.1) {
        const g = Math.abs((dEle / dDist) * 100);
        if (g > maxGrade) maxGrade = g;
      }
    }

    hills.push({
      idx:       hills.length + 1,
      startIdx,
      peakIdx,
      endIdx,
      startDist: pts[startIdx].dist,
      topDist:   pts[peakIdx].dist,
      topEle:    pts[peakIdx].ele,
      startEle:  pts[startIdx].ele,
      climb:     Math.round(climb),
      length:    parseFloat(climbDist.toFixed(2)),
      avgGrade:  parseFloat(avgGrade.toFixed(1)),
      maxGrade:  parseFloat(maxGrade.toFixed(1)),
      category:  gradeCategory(avgGrade),
    });
  });

  // Deduplicate overlapping hills (keep highest prominence)
  const deduped = [];
  hills.sort((a, b) => b.climb - a.climb);
  hills.forEach(h => {
    const overlaps = deduped.some(d =>
      Math.abs(d.topDist - h.topDist) < 0.5 && Math.abs(d.topEle - h.topEle) < 20
    );
    if (!overlaps) deduped.push(h);
  });
  deduped.sort((a, b) => a.startDist - b.startDist);
  deduped.forEach((h, i) => h.idx = i + 1);
  return deduped;
}

function gradeCategory(g) {
  const abs = Math.abs(g);
  if (abs < GRADE.easy)     return 'Easy';
  if (abs < GRADE.moderate) return 'Moderate';
  if (abs < GRADE.hard)     return 'Hard';
  return 'Very Hard';
}

function effortCategory(g) {
  if (g < 0) return 'Easy';
  return gradeCategory(g);
}

function gradeColor(g) {
  const cat = effortCategory(g);
  return { Easy: '#22c55e', Moderate: '#eab308', Hard: '#f97316', 'Very Hard': '#ef4444' }[cat];
}

// ─── Summary stats ────────────────────────────────────────────────────────────
function computeSummary(pts, hills) {
  let totalAscent = 0, totalDescent = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].ele - pts[i-1].ele;
    if (d > 0) totalAscent  += d;
    else        totalDescent += Math.abs(d);
  }
  const eles = pts.map(p => p.ele);
  const maxEle = Math.max(...eles), minEle = Math.min(...eles);
  const totalDist = pts[pts.length - 1].dist;

  const hardestHill = hills.length
    ? hills.reduce((a, b) => b.maxGrade > a.maxGrade ? b : a)
    : null;
  const longestHill = hills.length
    ? hills.reduce((a, b) => b.length > a.length ? b : a)
    : null;

  return {
    totalDist: totalDist.toFixed(2),
    totalAscent: Math.round(totalAscent),
    totalDescent: Math.round(totalDescent),
    maxEle: Math.round(maxEle),
    minEle: Math.round(minEle),
    elevRange: Math.round(maxEle - minEle),
    hillCount: hills.length,
    hardestHill,
    longestHill,
  };
}

// ─── Render summary cards ─────────────────────────────────────────────────────
function renderSummary(s) {
  const grid = document.getElementById('summary-grid');
  const cards = [
    { label: 'Distance',        value: s.totalDist,    unit: 'km' },
    { label: 'Total Ascent',    value: s.totalAscent,  unit: 'm' },
    { label: 'Total Descent',   value: s.totalDescent, unit: 'm' },
    { label: 'Max Elevation',   value: s.maxEle,       unit: 'm' },
    { label: 'Min Elevation',   value: s.minEle,       unit: 'm' },
    { label: 'Elev. Range',     value: s.elevRange,    unit: 'm' },
    { label: 'Hills Detected',  value: s.hillCount,    unit: '' },
  ];
  if (s.hardestHill) cards.push({
    label: 'Hardest Climb',
    value: s.hardestHill.maxGrade.toFixed(1),
    unit: '% max grade',
  });
  if (s.longestHill) cards.push({
    label: 'Longest Climb',
    value: s.longestHill.length,
    unit: 'km',
  });
  grid.innerHTML = cards.map(c => `
    <div class="card">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}<span class="unit">${c.unit}</span></div>
    </div>
  `).join('');
}

// ─── Render elevation chart ────────────────────────────────────────────────────
let chartInstance = null;
function renderChart(pts, gradients, hills, smoothed) {
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  const labels   = pts.map(p => p.dist.toFixed(2));
  const eleData  = pts.map(p => p.ele);

  // Segment colors based on gradient (5-point segments, averaged gradient)
  const segLen = 5;
  const pointColors = pts.map((_, i) => {
    const segStart = Math.floor(i / segLen) * segLen;
    const segEnd = Math.min(segStart + segLen, gradients.length);
    const segGrades = gradients.slice(segStart, segEnd);
    const g = segGrades.reduce((a, b) => a + b, 0) / segGrades.length;
    return gradeColor(g);
  });

  // Top annotations
  const topAnnotations = {};
  hills.forEach(h => {
    topAnnotations[`top${h.idx}`] = {
      type: 'point',
      xValue: pts[h.peakIdx].dist.toFixed(2),
      yValue: pts[h.peakIdx].ele,
      backgroundColor: '#818cf8',
      radius: 5,
      borderColor: '#fff',
      borderWidth: 1,
    };
  });

  const ctx = document.getElementById('elev-chart').getContext('2d');
  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Elevation (m)',
        data: eleData,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
        borderColor: ctx => {
          const { ctx: c, chartArea } = ctx.chart;
          if (!chartArea) return '#818cf8';
          return '#818cf8';
        },
        segment: {
          borderColor: ctx => pointColors[ctx.p0DataIndex] || '#818cf8',
        },
        backgroundColor: (ctx) => {
          const { ctx: c, chartArea } = ctx.chart;
          if (!chartArea) return 'rgba(99,102,241,0.15)';
          const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          gradient.addColorStop(0, 'rgba(99,102,241,0.35)');
          gradient.addColorStop(1, 'rgba(99,102,241,0.02)');
          return gradient;
        },
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2e3247',
          borderWidth: 1,
          titleColor: '#8892a4',
          bodyColor: '#e2e8f0',
          callbacks: {
            title: items => `${items[0].label} km`,
            label: item => {
              const i = item.dataIndex;
              const g = gradients[i];
              const cat = effortCategory(g);
              return [
                `Elevation: ${item.raw.toFixed(0)} m`,
                `Gradient:  ${g.toFixed(1)}%  (${cat})`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#8892a4',
            maxTicksLimit: 10,
            callback: (v, i) => `${labels[i]} km`,
          },
          grid: { color: '#2e3247' },
        },
        y: {
          ticks: { color: '#8892a4' },
          grid: { color: '#2e3247' },
          title: { display: true, text: 'Elevation (m)', color: '#8892a4', font: { size: 11 } },
        },
      },
    },
  });
}

// ─── Render map ───────────────────────────────────────────────────────────────
let mapInstance = null;
let tileLayerInstance = null;

function applyTileProvider(providerKey) {
  if (!mapInstance) return;
  const p = TILE_PROVIDERS[providerKey] || TILE_PROVIDERS['osm'];
  if (tileLayerInstance) mapInstance.removeLayer(tileLayerInstance);
  tileLayerInstance = L.tileLayer(p.url, p.options).addTo(mapInstance);
}

function renderMap(pts, gradients, hills) {
  if (mapInstance) { mapInstance.remove(); mapInstance = null; tileLayerInstance = null; }

  const mapEl = document.getElementById('map');
  mapInstance = L.map(mapEl);

  const providerKey = document.getElementById('tile-provider').value;
  applyTileProvider(providerKey);

  // Color-coded polyline segments
  const segLen = 5; // points per segment
  for (let i = 0; i < pts.length - segLen; i += segLen) {
    const slice = pts.slice(i, i + segLen + 1).map(p => [p.lat, p.lon]);
    const segGrades = gradients.slice(i, i + segLen);
    const g = segGrades.reduce((a, b) => a + b, 0) / segGrades.length;
    const midPt = pts[i + Math.floor(segLen / 2)];
    L.polyline(slice, {
      color: gradeColor(g),
      weight: 4,
      opacity: 0.85,
    })
    .bindPopup(
      `Gradient: <b>${g.toFixed(1)}%</b><br>` +
      `Category: <b>${effortCategory(g)}</b><br>` +
      `Elevation: <b>${midPt.ele.toFixed(0)} m</b><br>` +
      `Distance: <b>${midPt.dist.toFixed(2)} km</b>`
    )
    .addTo(mapInstance);
  }

  // Top markers
  hills.forEach(h => {
    const p = pts[h.peakIdx];
    L.circleMarker([p.lat, p.lon], {
      radius: 7,
      fillColor: '#818cf8',
      color: '#fff',
      weight: 2,
      fillOpacity: 1,
    })
    .bindPopup(`<b>Hill ${h.idx}</b><br>
      Elevation: <b>${Math.round(h.topEle)} m</b><br>
      Climb: ${h.climb} m · ${h.length} km<br>
      Avg grade: ${h.avgGrade}% · Max: ${h.maxGrade}%<br>
      Category: ${h.category}`)
    .addTo(mapInstance);
  });

  // Store bounds for re-fitting after the panel becomes visible
  const latlngs = pts.map(p => [p.lat, p.lon]);
  mapInstance._trackBounds = L.polyline(latlngs).getBounds();
}

// ─── Render hills table ───────────────────────────────────────────────────────
let hillsData = [];
let sortState = { col: 'startDist', dir: 1 };

function badgeHTML(cat) {
  const cls = { Easy: 'easy', Moderate: 'moderate', Hard: 'hard', 'Very Hard': 'veryhard' }[cat] || 'easy';
  return `<span class="badge badge-${cls}">${cat}</span>`;
}

function renderHillsTable(hills) {
  const tbody = document.getElementById('hills-tbody');
  if (!hills.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="padding:1rem;color:#8892a4;text-align:center">No significant hills detected</td></tr>';
    return;
  }
  tbody.innerHTML = hills.map(h => `
    <tr>
      <td>${h.idx}</td>
      <td>${h.startDist.toFixed(2)}</td>
      <td>${h.topDist.toFixed(2)}</td>
      <td><b>${Math.round(h.topEle)}</b></td>
      <td>${h.climb}</td>
      <td>${h.length}</td>
      <td>${h.avgGrade}</td>
      <td>${h.maxGrade}</td>
      <td>${badgeHTML(h.category)}</td>
    </tr>
  `).join('');
}

function setupTableSort() {
  document.querySelectorAll('#hills-table thead th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (!col) return;
      if (sortState.col === col) sortState.dir *= -1;
      else { sortState.col = col; sortState.dir = 1; }

      document.querySelectorAll('#hills-table thead th').forEach(t => t.classList.remove('sorted-asc','sorted-desc'));
      th.classList.add(sortState.dir === 1 ? 'sorted-asc' : 'sorted-desc');

      const sorted = [...hillsData].sort((a, b) => {
        const va = a[col], vb = b[col];
        return typeof va === 'string' ? va.localeCompare(vb) * sortState.dir : (va - vb) * sortState.dir;
      });
      renderHillsTable(sorted);
    });
  });
}

// ─── Render gradient breakdown table ─────────────────────────────────────────
function renderGradientTable(pts, gradients) {
  const ranges = [
    { label: '< -12% (very steep down)',  min: -Infinity, max: -12 },
    { label: '-12% to -8% (steep down)',  min: -12,       max: -8  },
    { label: '-8% to -4% (moderate down)',min: -8,        max: -4  },
    { label: '-4% to 0% (gentle down)',   min: -4,        max: 0   },
    { label: '0% to 4% (flat/gentle up)', min: 0,         max: 4   },
    { label: '4% to 8% (moderate up)',    min: 4,         max: 8   },
    { label: '8% to 12% (steep up)',      min: 8,         max: 12  },
    { label: '> 12% (very steep up)',     min: 12,        max: Infinity },
  ];

  const totalDist = pts[pts.length - 1].dist;
  const rows = ranges.map(r => {
    let dist = 0;
    for (let i = 1; i < pts.length; i++) {
      const g = gradients[i];
      if (g >= r.min && g < r.max) dist += pts[i].dist - pts[i-1].dist;
    }
    const share = totalDist > 0 ? (dist / totalDist) * 100 : 0;
    const cat = r.max <= 0 ? 'Easy' : gradeCategory((r.min + Math.min(r.max, 99)) / 2);
    return { label: r.label, dist: dist.toFixed(2), share: share.toFixed(1), cat };
  }).filter(r => parseFloat(r.dist) > 0.01);

  const tbody = document.getElementById('grad-tbody');
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.label}</td>
      <td>${r.dist} km</td>
      <td>${r.share}%</td>
      <td>${badgeHTML(r.cat)}</td>
    </tr>
  `).join('');
}

// ─── Main analysis ────────────────────────────────────────────────────────────
function analyze(text) {
  const pts = parseGPX(text);
  const rawEle   = pts.map(p => p.ele);
  const smoothed = smooth(rawEle, SMOOTH_WINDOW);
  const gradients = computeGradients(pts);

  hillsData = detectHills(pts, smoothed);
  const summary = computeSummary(pts, hillsData);

  renderSummary(summary);
  renderChart(pts, gradients, hillsData, smoothed);
  renderMap(pts, gradients, hillsData);
  renderHillsTable(hillsData);
  renderGradientTable(pts, gradients);
}

// ─── File handling ────────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('error-box');
  el.textContent = '⚠ ' + msg;
  el.style.display = 'block';
}
function hideError() { document.getElementById('error-box').style.display = 'none'; }
function showSpinner(v) { document.getElementById('spinner').style.display = v ? 'block' : 'none'; }
function showResults(v) { document.getElementById('results').style.display = v ? 'block' : 'none'; }
function showUpload(v)  { document.getElementById('drop-zone').style.display = v ? 'block' : 'none'; }

function handleFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.gpx') && !file.type.includes('xml')) {
    showError('Please upload a .gpx file.');
    return;
  }
  hideError();
  showUpload(false);
  showSpinner(true);

  const reader = new FileReader();
  reader.onload = e => {
    try {
      analyze(e.target.result);
      showSpinner(false);
      showResults(true);
      setTimeout(() => {
        if (!mapInstance) return;
        mapInstance.invalidateSize();
        if (mapInstance._trackBounds) mapInstance.fitBounds(mapInstance._trackBounds, { padding: [10, 10] });
      }, 200);
    } catch (err) {
      showSpinner(false);
      showUpload(true);
      showError(err.message || 'Failed to parse GPX file.');
    }
  };
  reader.readAsText(file);
}

// ─── Events ───────────────────────────────────────────────────────────────────
const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

document.getElementById('reset-btn').addEventListener('click', () => {
  showResults(false);
  showUpload(true);
  hideError();
  fileInput.value = '';
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  if (mapInstance)   { mapInstance.remove();   mapInstance  = null; }
  hillsData = [];
  document.getElementById('summary-grid').innerHTML = '';
  document.getElementById('hills-tbody').innerHTML = '';
  document.getElementById('grad-tbody').innerHTML = '';
});

document.getElementById('tile-provider').addEventListener('change', e => {
  applyTileProvider(e.target.value);
});

// ─── Fullscreen ───────────────────────────────────────────────────────────────
const fullscreenBtn    = document.getElementById('fullscreen-btn');
const fsEnterIcon      = document.getElementById('fs-enter-icon');
const fsExitIcon       = document.getElementById('fs-exit-icon');
const mapPanelEl       = document.querySelector('.map-panel');

function updateFullscreenIcons() {
  const isFs = !!document.fullscreenElement;
  fsEnterIcon.style.display = isFs ? 'none'  : '';
  fsExitIcon.style.display  = isFs ? ''      : 'none';
}

fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    mapPanelEl.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
});

document.addEventListener('fullscreenchange', () => {
  updateFullscreenIcons();
  if (mapInstance) {
    setTimeout(() => {
      mapInstance.invalidateSize();
      if (mapInstance._trackBounds) mapInstance.fitBounds(mapInstance._trackBounds, { padding: [10, 10] });
    }, 100);
  }
});

setupTableSort();
