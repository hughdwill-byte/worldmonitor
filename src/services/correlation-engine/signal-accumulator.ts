import type { SignalEvidence } from './types';

const KEY_PREFIX = 'wm-corr-hist-';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PER_DOMAIN = 600;

interface StoredSignal {
  type: string;
  source: string;
  severity: number;
  lat?: number;
  lon?: number;
  country?: string;
  timestamp: number;
  label: string;
}

export function saveSignals(domain: string, signals: SignalEvidence[]): void {
  try {
    const key = KEY_PREFIX + domain;
    const existing = readRaw(key);
    const incoming: StoredSignal[] = signals.map(s => ({
      type: s.type,
      source: s.source,
      severity: s.severity,
      lat: s.lat,
      lon: s.lon,
      country: s.country,
      timestamp: s.timestamp,
      label: s.label,
    }));

    const seen = new Set<string>();
    const merged: StoredSignal[] = [];
    for (const s of [...incoming, ...existing]) {
      const k = `${s.type}|${s.label}|${Math.floor(s.timestamp / 3_600_000)}`;
      if (!seen.has(k)) { seen.add(k); merged.push(s); }
    }

    const cutoff = Date.now() - MAX_AGE_MS;
    const pruned = merged
      .filter(s => s.timestamp >= cutoff)
      .sort((a, b) => b.severity - a.severity)
      .slice(0, MAX_PER_DOMAIN);

    localStorage.setItem(key, JSON.stringify(pruned));
  } catch {
    // Storage full or unavailable — fail silently
  }
}

export function loadSignals(domain: string): SignalEvidence[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  return readRaw(KEY_PREFIX + domain)
    .filter(s => s.timestamp >= cutoff)
    .map(s => ({ ...s, rawData: undefined }));
}

function readRaw(key: string): StoredSignal[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as StoredSignal[]) : [];
  } catch {
    return [];
  }
}
