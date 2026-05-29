import type { SignalEvidence } from './types';

const CACHE_KEY = 'wm-corr-usgs-hist';
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 30;
const MIN_MAGNITUDE = 4.5;

interface CacheEntry {
  signals: CachedSignal[];
  fetchedAt: number;
}

interface CachedSignal {
  label: string;
  lat: number;
  lon: number;
  severity: number;
  timestamp: number;
}

interface UsgsFeatureCollection {
  features: Array<{
    geometry: { coordinates: [number, number, number] };
    properties: { mag: number; place: string; time: number };
  }>;
}

let inFlight: Promise<SignalEvidence[]> | null = null;

export function fetchHistoricalUsgsSignals(): Promise<SignalEvidence[]> {
  const cached = readCache();
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = doFetch().finally(() => { inFlight = null; });
  return inFlight;
}

async function doFetch(): Promise<SignalEvidence[]> {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().split('T')[0];

    const url =
      `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
      `&starttime=${fmt(start)}&endtime=${fmt(end)}` +
      `&minmagnitude=${MIN_MAGNITUDE}&orderby=time&limit=500`;

    const resp = await fetch(url);
    if (!resp.ok) return [];

    const data = await resp.json() as UsgsFeatureCollection;
    const signals = data.features.map(f => {
      const [lon, lat] = f.geometry.coordinates;
      const mag = f.properties.mag;
      return {
        type: 'earthquake',
        source: 'usgs-historical',
        severity: Math.min(100, Math.max(10, (mag - 1.5) * 17)),
        lat,
        lon,
        timestamp: f.properties.time,
        label: `M${mag.toFixed(1)} — ${f.properties.place}`,
      } satisfies SignalEvidence;
    });

    writeCache(signals);
    return signals;
  } catch {
    return [];
  }
}

function readCache(): SignalEvidence[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
    return entry.signals.map(s => ({
      type: 'earthquake',
      source: 'usgs-historical',
      severity: s.severity,
      lat: s.lat,
      lon: s.lon,
      timestamp: s.timestamp,
      label: s.label,
    }));
  } catch {
    return null;
  }
}

function writeCache(signals: SignalEvidence[]): void {
  try {
    const entry: CacheEntry = {
      fetchedAt: Date.now(),
      signals: signals.map(s => ({
        label: s.label,
        lat: s.lat!,
        lon: s.lon!,
        severity: s.severity,
        timestamp: s.timestamp,
      })),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {}
}
