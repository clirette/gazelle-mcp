import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { dataFile } from "../paths.js";
import type { Address } from "../gazelle/types.js";
import type { DistanceProvider } from "./mileage.js";

const METERS_PER_MILE = 1609.344;

/** Persistent JSON cache so each coordinate pair / address is only looked up once. */
class JsonCache {
  private data: Record<string, unknown> | undefined;
  constructor(private path: string) {}
  private async load() {
    if (!this.data) {
      try {
        this.data = JSON.parse(await readFile(this.path, "utf8"));
      } catch {
        this.data = {};
      }
    }
    return this.data!;
  }
  async get<T>(k: string): Promise<T | undefined> {
    return (await this.load())[k] as T | undefined;
  }
  async set(k: string, v: unknown) {
    (await this.load())[k] = v;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.data));
  }
}

const key = (a: Address) => `${a.lat!.toFixed(5)},${a.lng!.toFixed(5)}`;

/**
 * Real driving distance via an OSRM server. Only bare coordinates are sent (no names or
 * street addresses). Default is the public OSRM demo server (best-effort, rate-limited);
 * set GAZELLE_OSRM_URL to a self-hosted instance for production use.
 */
export class OsrmProvider implements DistanceProvider {
  private cache = new JsonCache(process.env.GAZELLE_ROUTE_CACHE ?? dataFile("route-cache.json"));
  constructor(private baseUrl = process.env.GAZELLE_OSRM_URL ?? "https://router.project-osrm.org") {}

  async miles(from: Address, to: Address): Promise<number> {
    if (from.lat == null || from.lng == null || to.lat == null || to.lng == null) {
      throw new Error("missing coordinates");
    }
    const k = `${key(from)}|${key(to)}`;
    const hit = await this.cache.get<number>(k);
    if (hit != null) return hit;

    const url = `${this.baseUrl}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const res = await fetchRetry(url);
    const body = (await res.json()) as { code: string; routes?: { distance: number }[] };
    if (body.code !== "Ok" || !body.routes?.length) throw new Error(`no route (${body.code})`);
    const miles = body.routes[0].distance / METERS_PER_MILE;
    await this.cache.set(k, miles);
    return miles;
  }
}

async function fetchRetry(url: string, tries = 3): Promise<Response> {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: { "User-Agent": "gazelle-mcp" } });
    if (res.ok) return res;
    if (i >= tries - 1 || (res.status !== 429 && res.status < 500)) throw new Error(`HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
}

/**
 * Geocode a US address with the free US Census geocoder (no API key). Sends the street
 * address to the Census Bureau; results are cached on disk. Used for the home address and
 * as a fallback for appointments where Gazelle has no coordinates.
 */
export async function geocode(a: Address): Promise<Address> {
  if (a.lat != null && a.lng != null) return a;
  const line = [a.line1, a.city, a.state, a.postalCode].filter(Boolean).join(", ");
  if (!line) throw new Error("empty address");
  const cache = new JsonCache(process.env.GAZELLE_GEOCODE_CACHE ?? dataFile("geocode-cache.json"));
  let hit = await cache.get<{ lat: number; lng: number }>(line.toLowerCase());
  if (!hit) {
    const url =
      "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?" +
      new URLSearchParams({ address: line, benchmark: "Public_AR_Current", format: "json" });
    const body = (await (await fetchRetry(url)).json()) as {
      result?: { addressMatches?: { coordinates: { x: number; y: number } }[] };
    };
    const m = body.result?.addressMatches?.[0];
    if (!m) throw new Error(`could not geocode "${line}"`);
    hit = { lat: m.coordinates.y, lng: m.coordinates.x };
    await cache.set(line.toLowerCase(), hit);
  }
  return { ...a, ...hit };
}
