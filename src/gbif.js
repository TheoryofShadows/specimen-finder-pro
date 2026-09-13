'use strict';

const GBIF_BASE = 'https://api.gbif.org/v1';
const USER_AGENT =
  'SpecimenFinderPro/1.0 (+https://github.com/TheoryofShadows/specimen-finder-pro; hosted research workflow; not a data reseller)';
const MIN_INTERVAL_MS = 1100;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

let lastCallAt = 0;
let queue = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

function queued(fn) {
  const run = queue.then(async () => {
    await throttle();
    return fn();
  });
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function gbifGet(pathnameAndQuery) {
  return queued(async () => {
    const url = `${GBIF_BASE}${pathnameAndQuery}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`GBIF ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = text.slice(0, 400);
      throw err;
    }
    return res.json();
  });
}

async function matchSpecies(query) {
  const q = String(query || '').trim();
  if (!q) {
    const err = new Error('Species query required');
    err.status = 400;
    throw err;
  }
  const data = await gbifGet(
    `/species/match?name=${encodeURIComponent(q)}&kingdom=Plantae`
  );
  return data;
}

function pickOccurrence(rec) {
  const key = rec.key ?? rec.gbifID;
  return {
    gbifID: key ?? '',
    scientificName: rec.scientificName || rec.species || '',
    recordedBy: rec.recordedBy || '',
    eventDate: rec.eventDate || '',
    year: rec.year ?? '',
    country: rec.country || rec.countryCode || '',
    stateProvince: rec.stateProvince || '',
    locality: rec.locality || '',
    decimalLatitude: rec.decimalLatitude ?? '',
    decimalLongitude: rec.decimalLongitude ?? '',
    institutionCode: rec.institutionCode || '',
    catalogNumber: rec.catalogNumber || '',
    collectionCode: rec.collectionCode || '',
    datasetKey: rec.datasetKey || '',
    license: rec.license || '',
    gbifUrl: key ? `https://www.gbif.org/occurrence/${key}` : '',
  };
}

async function fetchSpecimens(taxonKey, limit = DEFAULT_LIMIT) {
  const key = Number(taxonKey);
  if (!Number.isFinite(key) || key <= 0) {
    const err = new Error('Valid GBIF taxon key required');
    err.status = 400;
    throw err;
  }
  const n = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);
  const data = await gbifGet(
    `/occurrence/search?taxonKey=${encodeURIComponent(key)}&basisOfRecord=PRESERVED_SPECIMEN&limit=${n}`
  );
  const results = Array.isArray(data.results) ? data.results.map(pickOccurrence) : [];
  return {
    count: Number(data.count) || results.length,
    endOfRecords: Boolean(data.endOfRecords),
    limit: n,
    results,
  };
}

async function pullForQuery(query, limit = DEFAULT_LIMIT) {
  const match = await matchSpecies(query);
  const matchStatus = String(match.matchType || match.status || '').toUpperCase();
  const taxonKey = match.usageKey || match.speciesKey || match.acceptedUsageKey;
  if (!taxonKey || matchStatus === 'NONE' || match.confidence === 0) {
    const err = new Error(`No Plantae match on GBIF for “${query}”`);
    err.status = 404;
    err.match = match;
    throw err;
  }
  const specimens = await fetchSpecimens(taxonKey, limit);
  return {
    query,
    match: {
      scientificName: match.scientificName || match.canonicalName || query,
      canonicalName: match.canonicalName || '',
      rank: match.rank || '',
      status: match.status || '',
      matchType: match.matchType || '',
      confidence: match.confidence ?? null,
      taxonKey,
      kingdom: match.kingdom || 'Plantae',
    },
    ...specimens,
    attribution:
      'Occurrence data via GBIF API (https://www.gbif.org). Individual records carry publisher licenses (often CC0, CC BY, or CC BY-NC). Specimen Finder Pro is a personal research workflow and does not sell or redistribute publisher content.',
    fetchedAt: new Date().toISOString(),
  };
}

function referenceLinks(scientificName, taxonKey) {
  const name = scientificName || '';
  const wikiTitle = name.replace(/\s+/g, '_');
  return {
    gbifSpecies: taxonKey ? `https://www.gbif.org/species/${taxonKey}` : '',
    wikipedia: name ? `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTitle)}` : '',
    wikidata: name
      ? `https://www.wikidata.org/w/index.php?search=${encodeURIComponent(name)}`
      : '',
    powo: name ? `https://powo.science.kew.org/?q=${encodeURIComponent(name)}` : '',
  };
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const CSV_COLUMNS = [
  'gbifID',
  'scientificName',
  'recordedBy',
  'eventDate',
  'year',
  'country',
  'stateProvince',
  'locality',
  'decimalLatitude',
  'decimalLongitude',
  'institutionCode',
  'catalogNumber',
  'collectionCode',
  'datasetKey',
  'license',
  'gbifUrl',
];

function toCsv(records) {
  const header = CSV_COLUMNS.join(',');
  const rows = (records || []).map((rec) =>
    CSV_COLUMNS.map((col) => csvEscape(rec[col])).join(',')
  );
  return [header, ...rows].join('\n') + '\n';
}

module.exports = {
  GBIF_BASE,
  USER_AGENT,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  matchSpecies,
  fetchSpecimens,
  pullForQuery,
  pickOccurrence,
  referenceLinks,
  toCsv,
  csvEscape,
  CSV_COLUMNS,
};
