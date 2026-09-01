import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("="); return [key, rest.join("=") || true];
}));
const input = path.resolve(String(args.input || "data/raw/bjsubway-map-20260630.svg"));
const output = path.resolve(String(args.output || "data/diagram-hotspots.official.json"));
const reportPath = path.resolve(String(args.report || "data/reports/bjsubway-svg-extraction.json"));
const network = JSON.parse(await fs.readFile("data/network.json", "utf8"));
const source = await fs.readFile(input, "utf8");
const $ = cheerio.load(source, { xmlMode: true });
const svg = $("svg#subwaymap_svg").first().length ? $("svg#subwaymap_svg").first() : $("svg").first();
if (!svg.length) throw new Error(`${input} 中没有 SVG 根元素。`);

const number = (value) => Number.parseFloat(value);
const normalizeColor = (value = "") => value.trim().toLowerCase();
const stationElements = svg.find("[sdata]").filter((_, element) => {
  const tag = element.tagName.toLowerCase();
  const value = $(element).attr("sdata") || "";
  return (tag === "circle" || tag === "image") && value && !value.includes(",");
});

const candidatesByName = new Map();
stationElements.each((_, element) => {
  const item = $(element); const tag = element.tagName.toLowerCase();
  const name = item.attr("sdata")?.trim();
  let x; let y; let radius; let symbol;
  if (tag === "circle") {
    x = number(item.attr("cx")); y = number(item.attr("cy")); radius = number(item.attr("r")) || 4; symbol = "ordinary";
  } else {
    const width = number(item.attr("width")) || 14; const height = number(item.attr("height")) || 14;
    x = number(item.attr("x")) + width / 2; y = number(item.attr("y")) + height / 2; radius = Math.max(width, height) / 2;
    const href = item.attr("href") || item.attr("xlink:href") || "";
    symbol = /gray|sb/i.test(href) ? "out_of_station_transfer" : "in_station_transfer";
  }
  if (![x, y].every(Number.isFinite)) return;
  const candidate = { x, y, radius, symbol, tag, sourceElementId: item.attr("id") || null, sourceClass: item.attr("class") || null };
  if (!candidatesByName.has(name)) candidatesByName.set(name, []);
  candidatesByName.get(name).push(candidate);
});

const chooseCandidate = (items) => {
  const transfer = items.find((item) => item.symbol !== "ordinary");
  return transfer || items[0];
};
const stationHotspots = [];
const missingNetworkStations = [];
for (const station of network.stations) {
  const candidates = candidatesByName.get(station.nameZh) || [];
  if (!candidates.length) { missingNetworkStations.push({ stationId: station.id, stationNameZh: station.nameZh }); continue; }
  const point = chooseCandidate(candidates);
  stationHotspots.push({
    stationId: station.id, stationNameZh: station.nameZh,
    x: point.x, y: point.y, radius: Math.max(7, point.radius),
    symbol: point.symbol, recognitionStatus: "official_exact_name", confidence: 1,
    evidence: { source: "map.bjsubway.com", sourceElementId: point.sourceElementId, occurrences: candidates.length }
  });
}

const networkNames = new Set(network.stations.map((station) => station.nameZh));
const extraOfficialStations = [...candidatesByName.entries()].filter(([name]) => !networkNames.has(name)).map(([name, candidates]) => ({ name, occurrences: candidates.length, candidates }));
const duplicateOfficialStations = [...candidatesByName.entries()].filter(([, candidates]) => candidates.length > 1).map(([name, candidates]) => ({ name, occurrences: candidates.length }));

const primitives = [];
svg.find("line,path").each((_, element) => {
  const item = $(element); const stroke = normalizeColor(item.attr("stroke"));
  if (!stroke || stroke === "none" || (number(item.attr("stroke-width")) || 0) < 3) return;
  if (element.tagName.toLowerCase() === "line") {
    const x1 = number(item.attr("x1")), y1 = number(item.attr("y1")), x2 = number(item.attr("x2")), y2 = number(item.attr("y2"));
    if ([x1,y1,x2,y2].every(Number.isFinite)) primitives.push({ type: "line", stroke, start: [x1,y1], end: [x2,y2], d: `M${x1} ${y1} L${x2} ${y2}` });
  } else {
    const d = item.attr("d") || "";
    const coordinates = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(number);
    if (coordinates.length >= 4) primitives.push({ type: "path", stroke, start: coordinates.slice(0, 2), end: coordinates.slice(-2), d });
  }
});

const allXs = [...stationHotspots.map((item) => item.x), ...primitives.flatMap((item) => [item.start[0], item.end[0]])];
const allYs = [...stationHotspots.map((item) => item.y), ...primitives.flatMap((item) => [item.start[1], item.end[1]])];
const coordinateSystem = {
  type: "official_svg_units",
  width: Math.ceil(Math.max(...allXs) + 20), height: Math.ceil(Math.max(...allYs) + 20),
  viewportWidthAtCapture: number(svg.attr("width")) || null, viewportHeightAtCapture: number(svg.attr("height")) || null,
  sourceUrl: "https://map.bjsubway.com/", sourceVersion: "20260630"
};
const document = {
  schemaVersion: "0.2.0", datasetVersion: network.meta.datasetVersion,
  status: missingNetworkStations.length ? "needs_review" : "stations_ready_paths_pending",
  coordinateSystem, stationHotspots,
  officialPathPrimitives: primitives,
  segmentHotspots: [],
  source: { name: "北京地铁官方线网图", url: "https://map.bjsubway.com/", snapshot: path.relative(process.cwd(), input).replaceAll("\\", "/") }
};
const report = {
  generatedAt: new Date().toISOString(), sourceVersion: "20260630",
  counts: { networkStations: network.stations.length, officialUniqueStations: candidatesByName.size, matchedStations: stationHotspots.length, missingNetworkStations: missingNetworkStations.length, extraOfficialStations: extraOfficialStations.length, duplicateOfficialStations: duplicateOfficialStations.length, officialPathPrimitives: primitives.length },
  checks: { allNetworkStationsMatched: missingNetworkStations.length === 0, pathsCaptured: primitives.length > 500 },
  missingNetworkStations, extraOfficialStations, duplicateOfficialStations,
  safeToReplaceStationHotspots: missingNetworkStations.length === 0,
  safeToReplaceSegmentHotspots: false,
  notes: ["线路原始几何已完整保留；区间与路径片段的拓扑关联将在下一阶段生成。", "输出不会覆盖 data/diagram-hotspots.json 或人工标定文件。"]
};
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(path.dirname(reportPath), { recursive: true });
await Promise.all([fs.writeFile(output, `${JSON.stringify(document, null, 2)}\n`, "utf8"), fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")]);
console.log(`官网 SVG：匹配 ${stationHotspots.length}/${network.stations.length} 站；额外 ${extraOfficialStations.length} 站；路径图元 ${primitives.length} 个。`);
if (missingNetworkStations.length) console.warn(`需人工补充：${missingNetworkStations.map((item) => item.stationNameZh).join("、")}`);
if (args.strict && missingNetworkStations.length) process.exitCode = 1;
