import fs from "node:fs/promises";
import path from "node:path";

const inputPath = "data/raw/wikipedia/network-station-coordinates.json";
const outputPath = "data/raw/openstreetmap/network-station-coordinates.json";
const reportPath = "data/reports/openstreetmap-coordinate-match.json";
const source = JSON.parse(await fs.readFile(inputPath, "utf8"));

const query = `[out:json][timeout:180];
(
  nwr["railway"="station"](39.30,115.30,41.20,117.65);
  nwr["railway"="tram_stop"](39.30,115.30,41.20,117.65);
  nwr["public_transport"="station"]["station"~"subway|light_rail"](39.30,115.30,41.20,117.65);
  nwr["public_transport"="stop_position"]["subway"="yes"](39.30,115.30,41.20,117.65);
  nwr["public_transport"="stop_position"]["tram"="yes"](39.30,115.30,41.20,117.65);
  rel["type"="public_transport"]["public_transport"="stop_area"](39.30,115.30,41.20,117.65);
);
out center tags;`;

const endpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
let payload;
for (const endpoint of endpoints) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "BeijingRailTransitFootprint/0.1 (coordinate audit)" },
      body: new URLSearchParams({ data: query })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
    break;
  } catch (error) {
    console.warn(`${endpoint} 获取失败：${error.message}`);
  }
}
if (!payload) throw new Error("所有 Overpass API 端点均不可用");

function normalizeName(value = "") {
  return value.normalize("NFKC")
    .replace(/[（）()\s·]/g, "")
    .replace(/站$/, "")
    .replaceAll("臺", "台").replaceAll("門", "门").replaceAll("陽", "阳").replaceAll("興", "兴").toLowerCase();
}

function coordinate(element) {
  const point = element.type === "node" ? element : element.center;
  return point && Number.isFinite(point.lat) && Number.isFinite(point.lon) ? { lat: point.lat, lng: point.lon } : null;
}

const candidates = payload.elements.filter((element) => coordinate(element)).map((element) => ({
  osmType: element.type,
  osmId: element.id,
  lat: coordinate(element).lat,
  lng: coordinate(element).lng,
  tags: element.tags || {},
  names: [...new Set([element.tags?.["name:zh-Hans"], element.tags?.["name:zh"], element.tags?.name, element.tags?.official_name, element.tags?.alt_name].filter(Boolean))]
}));
const byName = new Map();
for (const candidate of candidates) {
  for (const name of candidate.names) {
    const key = normalizeName(name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(candidate);
  }
}

function haversineM(a, b) {
  const rad = (x) => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function rank(candidate) {
  return (candidate.tags.station === "subway" ? 100 : 0)
    + (candidate.tags.station === "light_rail" ? 90 : 0)
    + (candidate.tags.subway === "yes" ? 30 : 0)
    + (candidate.tags.railway === "station" ? 20 : 0)
    + (candidate.tags.railway === "tram_stop" ? 20 : 0)
    + (candidate.osmType === "node" ? 5 : 0);
}

const stations = {};
const report = [];
for (const [name, old] of Object.entries(source.stations)) {
  const matches = [...new Map((byName.get(normalizeName(name)) || []).map((item) => [`${item.osmType}/${item.osmId}`, item])).values()];
  const ranked = matches.sort((a, b) => rank(b) - rank(a));
  const best = ranked[0];
  const tied = best ? ranked.filter((item) => rank(item) === rank(best)) : [];
  const spreadM = tied.length > 1 ? Math.max(...tied.map((item) => haversineM(best, item))) : 0;
  const accepted = best && (tied.length === 1 || spreadM <= 1000);
  if (accepted) {
    stations[name] = {
      title: old.title,
      lat: best.lat,
      lng: best.lng,
      coordinateSource: "openstreetmap",
      osmType: best.osmType,
      osmId: best.osmId,
      osmTags: { name: best.tags.name, "name:zh": best.tags["name:zh"], station: best.tags.station, railway: best.tags.railway },
      retrievedAt: new Date().toISOString().slice(0, 10)
    };
  } else {
    stations[name] = { ...old, coordinateSource: old.coordinateSource || "wikipedia-fallback" };
  }
  report.push({
    stationNameZh: name,
    status: accepted ? "matched" : matches.length ? "ambiguous" : "unmatched",
    candidateCount: matches.length,
    ...(accepted ? { osmType: best.osmType, osmId: best.osmId, displacementFromWikipediaM: Math.round(haversineM(old, best)) } : {}),
    ...(matches.length && !accepted ? { candidates: matches.map((item) => ({ osmType: item.osmType, osmId: item.osmId, lat: item.lat, lng: item.lng, tags: item.tags })) } : {})
  });
}

const summary = {
  total: report.length,
  matched: report.filter((item) => item.status === "matched").length,
  ambiguous: report.filter((item) => item.status === "ambiguous").length,
  unmatched: report.filter((item) => item.status === "unmatched").length,
  displacedOver500M: report.filter((item) => item.displacementFromWikipediaM > 500).length
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await Promise.all([
  fs.writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), license: "ODbL 1.0", stations }, null, 2)}\n`, "utf8"),
  fs.writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), summary, stations: report }, null, 2)}\n`, "utf8")
]);
console.log(`OpenStreetMap 坐标匹配：${summary.matched}/${summary.total}，歧义 ${summary.ambiguous}，未匹配 ${summary.unmatched}，与原坐标相差超过 500 米 ${summary.displacedOver500M}。`);
