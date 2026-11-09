'use strict';

const $ = (id) => document.getElementById(id);
const strings = {
  en: {
    title: 'Walking Distance', election: 'Knesset 26 · 2026',
    walkTitle: (n) => n + '-minute walk', walkTime: 'Walking time', minutes: (n) => n + (n === 1 ? ' minute' : ' minutes'),
    home: 'Yoav Fried', source: 'Source code', osm: '© OpenStreetMap contributors',
    validVotes: 'Estimated valid votes', walkArea: 'Walk area', unit: 'km²',
    breakdown: 'Vote breakdown', estimates: 'Estimates', dotKey: '1 estimated vote',
    note: 'The results are inaccurate and are calculated based on ballot locations and statistical areas.',
    mapLabel: 'Walking area map', center: 'Use map center', coordinates: 'Pin coordinates',
    resultsLabel: 'Estimated election results', zoomIn: 'Zoom in', zoomOut: 'Zoom out',
    canvas: 'Israel map. Pan and use the Use map center button to set a point by keyboard.',
    calculating: 'Calculating the walk…', noVotes: 'No estimated votes from mapped areas in this walk.',
    noRoute: 'No walking route was found here. Try a nearby street.',
    outside: 'Choose a starting point within the Israel map extent.',
    busy: 'The walking service is busy. Try again in a moment.',
    failed: 'Could not calculate this walk. Try again.',
    retry: 'Retry', showAll: (n) => 'Show all ' + n + ' parties', fewer: 'Show fewer parties',
  },
  he: {
    title: 'מרחק הליכה', election: 'הכנסת ה־26 · 2026',
    walkTitle: (n) => n + ' דקות הליכה', walkTime: 'משך ההליכה', minutes: (n) => n + ' דקות',
    home: 'יואב פריד', source: 'קוד המקור', osm: '© תורמי OpenStreetMap',
    validVotes: 'אומדן קולות כשרים', walkArea: 'שטח ההליכה', unit: 'קמ״ר',
    breakdown: 'התפלגות קולות', estimates: 'אומדנים', dotKey: 'קול אחד באומדן',
    note: 'התוצאות לא מדויקות ומחושבות על בסיס מיקומי קלפיות ואיזורים סטטיסטיים.',
    mapLabel: 'מפת אזור ההליכה', center: 'בחירה במרכז המפה', coordinates: 'קואורדינטות של הנקודה',
    resultsLabel: 'אומדן תוצאות הבחירות', zoomIn: 'הגדלה', zoomOut: 'הקטנה',
    canvas: 'מפת ישראל. לבחירה באמצעות המקלדת, הזיזו את המפה ולחצו על בחירה במרכז המפה.',
    calculating: 'מחשבים את אזור ההליכה…', noVotes: 'אין אומדן קולות מאזורים שמופו בטווח ההליכה הזה.',
    noRoute: 'לא נמצא מסלול הליכה מכאן. נסו רחוב סמוך.',
    outside: 'בחרו נקודת התחלה בתחום המפה.',
    busy: 'שירות ההליכה עמוס. נסו שוב בעוד רגע.',
    failed: 'לא ניתן לחשב את אזור ההליכה. נסו שוב.',
    retry: 'ניסיון נוסף', showAll: (n) => 'הצגת כל ' + n + ' הרשימות', fewer: 'הצגת פחות רשימות',
  },
};
const pageUrl = new URL(location.href);
const explicitLanguage = pageUrl.searchParams.get('lang');
let language = 'en';
try {
  if (localStorage.getItem('walk-vote-language') === 'he') language = 'he';
} catch { /* The demo also works when browser storage is unavailable. */ }
if (explicitLanguage === 'en' || explicitLanguage === 'he') language = explicitLanguage;
const t = (key) => strings[language][key];
const asset = (path) => new URL(path, document.baseURI);
const estimator = new Worker(asset('estimate-worker.js'));
let number, percent, decimal;
const empty = { type: 'FeatureCollection', features: [] };
const fallbackStyle = {
  version: 8,
  sources: { land: { type: 'geojson', data: asset('map-context.geojson').href } },
  layers: [
    { id: 'water', type: 'background', paint: { 'background-color': '#0d1519' } },
    { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': '#212621' } },
  ],
};

let result = null;
let visibleWalk = null;
let expanded = false;
let activeParty = null;
let selected = [34.7748, 32.0776];
let statusKey = 'calculating';
let hasError = false;
let requestId = 0;
let scheduled;
let estimateController;
let pointController;
let pinId = 0;
let pointGrid;
let isInitial;
let minutes = Number($('walk-minutes').value);
let fitPending = false;
let estimates = new Map();

maplibregl.setRTLTextPlugin(asset('map-rtl.js').href, true).catch(console.warn);
const map = new maplibregl.Map({
  container: 'map', style: fallbackStyle, center: selected, zoom: 13.7,
  minZoom: 6.5, maxZoom: 18, maxBounds: [[33.8, 29.2], [36.3, 33.7]],
  dragRotate: false, pitchWithRotate: false, maxPitch: 0,
  attributionControl: { compact: true },
});
map.touchZoomRotate.disableRotation();
map.doubleClickZoom.disable();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const markerElement = document.createElement('div');
const pin = document.createElement('div');
pin.className = 'pin';
markerElement.append(pin);
const marker = new maplibregl.Marker({ element: markerElement, anchor: 'bottom' }).setLngLat(selected).addTo(map);

function illuminatedColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return '#9caea5';
  const rgb = hex.slice(1).match(/../g).map((channel) => parseInt(channel, 16));
  const light = 0.15 + 0.31 * (1 - Math.max(...rgb) / 255);
  return '#' + rgb.map((channel) => Math.round(channel + (255 - channel) * light).toString(16).padStart(2, '0')).join('');
}

function highlightParty(party) {
  activeParty = party;
  for (const button of $('votes').querySelectorAll('.party-toggle')) {
    button.setAttribute('aria-pressed', String(button.dataset.party === activeParty));
  }
  if (!map.getLayer('vote-points')) return;
  const opacity = (all, match, rest) => activeParty === null
    ? all
    : ['case', ['==', ['get', 'party'], activeParty], match, rest];
  map.setPaintProperty('vote-points', 'circle-opacity', opacity(0.88, 1, 0.09));
  map.setPaintProperty('vote-halo', 'circle-opacity', opacity(0.16, 0.4, 0.015));
}

function paintMap() {
  if (!map.getSource('walk')) return;
  map.getSource('walk').setData(visibleWalk ?? empty);
  map.getSource('overlaps').setData(result?.overlaps ?? empty);
  map.getSource('vote-dots').setData(result?.dots ?? empty);
  const density = result?.areaKm2 ? result.votes / result.areaKm2 : 0;
  const scale = density > 8500 ? Math.sqrt(8500 / density) : 1;
  const radius = (halo) => [
    'interpolate', ['linear'], ['zoom'],
    ...[[9, 1.1], [13, 1.68], [15, 2.25], [18, 3.4]].flatMap(([zoom, pixels]) => [
      zoom, Math.max(1.05, pixels * scale) * halo,
    ]),
  ];
  const colors = result?.parties.flatMap((party) => [party.id, illuminatedColor(party.color)]) ?? [];
  const palette = colors.length ? ['match', ['get', 'party'], ...colors, '#9caea5'] : '#9caea5';
  for (const [layer, halo] of [['vote-points', 1], ['vote-halo', 2.3]]) {
    map.setPaintProperty(layer, 'circle-radius', radius(halo));
    map.setPaintProperty(layer, 'circle-color', palette);
  }
  highlightParty(activeParty);
}

function updateMapLanguage() {
  map.getCanvas().setAttribute('aria-label', t('canvas'));
  for (const [selector, key] of [['.maplibregl-ctrl-zoom-in', 'zoomIn'], ['.maplibregl-ctrl-zoom-out', 'zoomOut']]) {
    const button = map.getContainer().querySelector(selector);
    button?.setAttribute('aria-label', t(key));
    button?.setAttribute('title', t(key));
  }
  const names = language === 'he'
    ? ['name:he', 'name:nonlatin', 'name', 'name:latin']
    : ['name:en', 'name:latin', 'name', 'name:nonlatin'];
  const expression = ['coalesce', ...names.map((key) => ['get', key])];
  for (const layer of map.getStyle()?.layers ?? []) {
    if (layer.type === 'symbol' && layer.source === 'openmaptiles' && /name/.test(JSON.stringify(layer.layout?.['text-field']))) {
      map.setLayoutProperty(layer.id, 'text-field', expression);
    }
  }
}

map.on('style.load', () => {
  const labels = map.getStyle().layers.find((layer) => layer.type === 'symbol' && layer['source-layer'] === 'transportation_name')?.id;
  map.addSource('walk', { type: 'geojson', data: empty });
  map.addSource('overlaps', { type: 'geojson', data: empty });
  map.addSource('vote-dots', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'walk-fill', source: 'walk', type: 'fill',
    paint: { 'fill-color': '#3c856a', 'fill-opacity': 0.15 },
  }, labels);
  map.addLayer({
    id: 'area-lines', source: 'overlaps', type: 'line',
    paint: {
      'line-color': ['match', ['get', 'kind'], 'fallback', '#e7b878', '#a9c2b2'],
      'line-opacity': 0.66, 'line-width': 1.1, 'line-dasharray': [2, 2.4],
    },
  }, labels);
  map.addLayer({
    id: 'vote-halo', source: 'vote-dots', type: 'circle',
    paint: {
      'circle-color': '#9caea5', 'circle-radius': 3, 'circle-blur': 0.88,
      'circle-opacity': 0.16, 'circle-opacity-transition': { duration: 120 },
    },
  }, 'area-lines');
  map.addLayer({
    id: 'vote-points', source: 'vote-dots', type: 'circle',
    paint: {
      'circle-color': '#9caea5', 'circle-radius': 1.5,
      'circle-opacity': 0.88, 'circle-opacity-transition': { duration: 120 },
    },
  }, 'area-lines');
  map.addLayer({
    id: 'walk-glow', source: 'walk', type: 'line',
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#82ecc5', 'line-width': 9, 'line-opacity': 0.4, 'line-blur': 4 },
  }, labels);
  map.addLayer({
    id: 'walk-line', source: 'walk', type: 'line',
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#a3f1ce', 'line-width': 2.2 },
  }, labels);
  updateMapLanguage();
  paintMap();
});

fetch('https://tiles.openfreemap.org/styles/dark', { signal: AbortSignal.timeout(6500) })
  .then((response) => {
    if (!response.ok) throw new Error('Street map unavailable');
    return response.json();
  })
  .then((style) => {
    const theme = {
      background: ['background-color', '#181c19'],
      water: ['fill-color', '#101a20'],
      landuse_residential: ['fill-color', '#212721'],
      building: ['fill-color', '#30372f'],
    };
    for (const layer of style.layers) {
      if (Object.hasOwn(theme, layer.id)) {
        const [property, color] = theme[layer.id];
        layer.paint[property] = color;
      }
      if (layer.type === 'symbol' && layer.layout?.['text-field']) {
        const street = layer['source-layer'] === 'transportation_name';
        layer.paint = {
          ...layer.paint,
          'text-color': street ? '#bdc9bf' : '#e0eae2',
          'text-halo-color': '#101713',
          'text-halo-width': street ? 1.35 : 1.6,
          'text-halo-blur': 0.45,
        };
      }
    }
    map.setStyle(style, { diff: false });
  })
  .catch(() => { /* Keep the local land outline if the street style cannot load. */ });

function status(key, error = false) {
  statusKey = key;
  hasError = error;
  $('status').textContent = key ? t(key) : '';
  $('status').toggleAttribute('data-error', hasError);
  $('retry').hidden = !hasError;
}

function applyLanguage() {
  document.documentElement.lang = language;
  $('vote-section').dir = language === 'he' ? 'rtl' : 'ltr';
  document.title = t('title');
  const locale = language === 'he' ? 'he-IL' : 'en-US';
  number = new Intl.NumberFormat(locale);
  percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  decimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const node of document.querySelectorAll('[data-text]')) node.textContent = t(node.dataset.text);
  for (const node of document.querySelectorAll('[data-label]')) node.setAttribute('aria-label', t(node.dataset.label));
  $('center').title = t('center');
  const other = language === 'he' ? 'en' : 'he';
  $('language-label').lang = other;
  $('language-label').dir = other === 'he' ? 'rtl' : 'ltr';
  $('language-label').textContent = other === 'he' ? 'עברית' : 'English';
  status(statusKey, hasError);
  renderWalkTime();
  updateMapLanguage();
  renderResults();
}

function renderWalkTime() {
  for (const node of document.querySelectorAll('[data-walk-title]')) node.textContent = t('walkTitle')(minutes);
  $('walk-minutes').setAttribute('aria-valuetext', t('minutes')(minutes));
  $('contour-key').hidden = minutes === 0;
}

function votes() {
  const positive = result?.parties.filter((party) => party.votes > 0) ?? [];
  $('votes').replaceChildren(...(expanded && result ? result.parties : positive.slice(0, 8)).map((party) => {
    const row = document.createElement('li');
    row.className = 'vote-row';
    row.style.setProperty('--party', illuminatedColor(party.color));
    row.style.setProperty('--share', (party.share * 100) + '%');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'party-toggle';
    button.dataset.party = party.id;
    button.disabled = party.votes === 0;
    button.setAttribute('aria-pressed', String(party.id === activeParty));
    const label = document.createElement('span');
    label.className = 'vote-label';
    const fields = [
      ['swatch', ''], ['party-name', language === 'he' ? party.nameHe || party.name : party.name || party.nameHe],
      ['count', number.format(party.votes)], ['share', percent.format(party.share)],
    ];
    for (const [className, value] of fields) {
      const cell = document.createElement('span');
      cell.className = className;
      if (className === 'party-name') cell.dir = 'auto';
      cell.textContent = value;
      label.append(cell);
    }
    const track = document.createElement('span');
    track.className = 'track';
    track.setAttribute('aria-hidden', 'true');
    track.append(document.createElement('i'));
    button.append(label, track);
    row.append(button);
    return row;
  }));
  $('more').hidden = !positive.length || result.parties.length <= Math.min(8, positive.length);
  $('more').textContent = expanded ? t('fewer') : t('showAll')(number.format(result?.parties.length ?? 0));
  $('more').setAttribute('aria-expanded', String(expanded));
}

function renderResults() {
  $('vote-total').textContent = result ? number.format(result.votes) : '—';
  $('walk-size').replaceChildren(document.createTextNode(result ? decimal.format(result.areaKm2) : '—'));
  if (result) {
    const unit = document.createElement('small');
    unit.textContent = ' ' + t('unit');
    $('walk-size').append(unit);
  }
  $('vote-section').hidden = !result?.votes;
  $('dot-key').hidden = !result?.dots?.features.length;
  votes();
}

function fitWalk(walk, duration = 500) {
  const bounds = new maplibregl.LngLatBounds(selected, selected);
  const extend = (part) => {
    if (typeof part[0] === 'number') bounds.extend(part);
    else part.forEach(extend);
  };
  extend(walk.geometry.coordinates);
  const mobile = matchMedia('(max-width: 720px)').matches;
  const pad = mobile ? { top: 68, bottom: 69, left: 28, right: 30 } : { top: 86, bottom: 86, left: 70, right: 70 };
  map.fitBounds(bounds, { padding: pad, maxZoom: 15.1, duration });
}

function estimateWalk(id, minutes, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      estimator.removeEventListener('message', receive);
      estimator.removeEventListener('error', fail);
      signal.removeEventListener('abort', fail);
    };
    const fail = () => {
      cleanup();
      reject(new Error('Estimate unavailable'));
    };
    const receive = ({ data }) => {
      if (data.id !== id) return;
      if (data.walk) {
        visibleWalk = data.walk;
        paintMap();
        return;
      }
      cleanup();
      if (data.error) reject(new Error(data.error));
      else resolve(data.result);
    };
    estimator.addEventListener('message', receive);
    estimator.addEventListener('error', fail);
    signal.addEventListener('abort', fail, { once: true });
    estimator.postMessage({ id, pin: pinId, minutes });
  });
}

async function loadRoute(path, point, signal) {
  const response = await fetch(asset(path), point ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(point), signal,
  } : { signal });
  if (!response.ok) {
    throw new Error({ 400: 'outside', 422: 'noRoute', 503: 'busy' }[response.status] || 'failed');
  }
  return response.arrayBuffer();
}

function gridForPoint() {
  if (!pointGrid) {
    const pin = pinId;
    pointGrid = loadRoute(
      isInitial ? 'initial-grid.tiff' : 'api/isochrone',
      isInitial ? null : { lon: selected[0], lat: selected[1] },
      pointController.signal,
    ).then((grid) => {
      if (pin === pinId) estimator.postMessage({ pin, grid }, [grid]);
    }).catch((error) => {
      if (pin === pinId) pointGrid = undefined;
      throw error;
    });
  }
  return pointGrid;
}

function showEstimate(estimate) {
  result = estimate;
  visibleWalk = estimate.walk;
  status(estimate.votes || minutes === 0 ? '' : 'noVotes');
  renderResults();
  paintMap();
  fitIfRequested();
}

function fitIfRequested() {
  if (fitPending && visibleWalk && result) {
    fitPending = false;
    fitWalk(visibleWalk);
  }
}

function updateWalk() {
  const id = ++requestId;
  const duration = minutes;
  clearTimeout(scheduled);
  estimateController?.abort();
  renderWalkTime();
  if (duration === 0) {
    fitPending = false;
    showEstimate({ votes: 0, areaKm2: 0, parties: [], walk: null });
    return;
  }
  if (estimates.has(duration)) {
    showEstimate(estimates.get(duration));
    return;
  }
  status('calculating');
  result = null;
  visibleWalk = null;
  renderResults();
  paintMap();

  estimateController = new AbortController();
  const { signal } = estimateController;
  scheduled = setTimeout(async () => {
    try {
      await gridForPoint();
      if (id !== requestId) return;
      const estimate = await estimateWalk(id, duration, signal);
      if (id !== requestId) return;
      if (estimates.size >= 5) estimates.delete(estimates.keys().next().value);
      estimates.set(duration, estimate);
      showEstimate(estimate);
    } catch (error) {
      if (id !== requestId) return;
      visibleWalk = null;
      paintMap();
      status(['outside', 'noRoute', 'busy'].includes(error.message) ? error.message : 'failed', true);
    }
  }, 45);
}

function selectPoint(point, initial = false) {
  selected = point;
  pointController?.abort();
  pointController = new AbortController();
  pinId++;
  isInitial = initial;
  pointGrid = undefined;
  estimates = new Map();
  marker.setLngLat(point);
  $('coordinates').textContent = point[1].toFixed(5) + ', ' + point[0].toFixed(5);
  expanded = false;
  activeParty = null;
  fitPending = true;
  updateWalk();
}

map.on('click', (event) => selectPoint(event.lngLat.toArray()));
map.on('resize', () => { if (result?.walk) fitWalk(result.walk, 0); });
$('walk-minutes').addEventListener('input', (event) => {
  minutes = Number(event.target.value);
  updateWalk();
});
$('walk-minutes').addEventListener('change', () => {
  fitPending = minutes > 0;
  fitIfRequested();
});
$('center').addEventListener('click', () => selectPoint(map.getCenter().toArray()));
$('language').addEventListener('click', () => {
  language = language === 'he' ? 'en' : 'he';
  try { localStorage.setItem('walk-vote-language', language); } catch { /* Keep the current choice in memory. */ }
  if (pageUrl.searchParams.has('lang')) {
    pageUrl.searchParams.set('lang', language);
    history.replaceState(null, '', pageUrl);
  }
  applyLanguage();
});
$('retry').addEventListener('click', () => selectPoint(selected));
$('votes').addEventListener('click', (event) => {
  const button = event.target.closest('.party-toggle');
  if (button) highlightParty(activeParty === button.dataset.party ? null : button.dataset.party);
});
$('more').addEventListener('click', () => {
  expanded = !expanded;
  if (!expanded && !result.parties.slice(0, 8).some((party) => party.id === activeParty)) highlightParty(null);
  votes();
});
applyLanguage();
selectPoint(selected, true);
