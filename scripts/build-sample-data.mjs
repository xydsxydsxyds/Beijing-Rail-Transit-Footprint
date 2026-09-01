import crypto from "node:crypto";
import fs from "node:fs/promises";
import { extractLine } from "./extract-wikipedia-lines.mjs";

const EFFECTIVE_DATE = "2026-06-30";
const SOURCE_DATE = "2026-08-27";
const inputs = [
  { file: "data/raw/wikipedia/line-6.html", lineId: "line-6", sourceId: "wiki-line-6" },
  { file: "data/raw/wikipedia/line-2.html", lineId: "line-2", sourceId: "wiki-line-2" },
  { file: "data/raw/wikipedia/line-1.html", lineId: "line-1", sourceId: "wiki-line-1" },
  { file: "data/raw/wikipedia/batong.html", lineId: "line-batong", sourceId: "wiki-line-batong" }
];

const districtNames = ["东城区", "西城区", "朝阳区", "海淀区", "丰台区", "石景山区", "通州区"];
const districtIds = new Map(districtNames.map((name) => [name, `district-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 10)}`]));
const stationId = (name) => `station-${[...name].map((character) => character.codePointAt(0).toString(16)).join("-")}`;
const lineStationId = (lineId, name) => `${lineId}.${stationId(name)}`;

function parseDistricts(text, stationName) {
  const names = districtNames.filter((name) => text.includes(name));
  if (!names.length && stationName === "东直门") return ["东城区"];
  if (!names.length) throw new Error(`${stationName}: 无法从“${text}”识别行政区`);
  return names;
}

function parseOpenedAt(text) {
  const match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!match) return undefined;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function deduplicateRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.nameZh}:${row.cumulativeM}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const extracted = {};
for (const input of inputs) {
  extracted[input.lineId] = deduplicateRows((await extractLine(input.file, input.lineId)).filter((row) => row.cumulativeM !== null));
}

// 八通线表从贯通边界后的高碑店开始，补入四惠东作为线路站点；首段距离取高碑店行的站间距。
const sihuiEast = extracted["line-1"].find((row) => row.nameZh === "四惠东");
extracted["line-batong"].unshift({
  lineId: "line-batong",
  nameZh: "四惠东",
  cumulativeM: sihuiEast.cumulativeM,
  distanceFromPreviousM: 0,
  districtNameZh: sihuiEast.districtNameZh,
  openedAtText: sihuiEast.openedAtText
});

const coordinateCache = JSON.parse(await fs.readFile("data/raw/wikipedia/station-coordinates.json", "utf8"));
const sourceForLine = new Map(inputs.map((item) => [item.lineId, item.sourceId]));
const occurrences = new Map();
for (const rows of Object.values(extracted)) {
  rows.forEach((row, index) => {
    if (!occurrences.has(row.nameZh)) occurrences.set(row.nameZh, []);
    occurrences.get(row.nameZh).push({ ...row, index, rows });
  });
}

const diagramCoordinates = new Map();
for (const [name, value] of Object.entries(coordinateCache.stations)) {
  if (!value.missing) diagramCoordinates.set(name, { lat: value.lat, lng: value.lng });
}
for (const [name, items] of occurrences) {
  if (diagramCoordinates.has(name)) continue;
  const item = items[0];
  let previous;
  let next;
  for (let index = item.index - 1; index >= 0; index -= 1) {
    if (diagramCoordinates.has(item.rows[index].nameZh)) { previous = item.rows[index]; break; }
  }
  for (let index = item.index + 1; index < item.rows.length; index += 1) {
    if (diagramCoordinates.has(item.rows[index].nameZh)) { next = item.rows[index]; break; }
  }
  if (previous && next) {
    const a = diagramCoordinates.get(previous.nameZh);
    const b = diagramCoordinates.get(next.nameZh);
    const ratio = (item.cumulativeM - previous.cumulativeM) / (next.cumulativeM - previous.cumulativeM);
    diagramCoordinates.set(name, { lat: a.lat + (b.lat - a.lat) * ratio, lng: a.lng + (b.lng - a.lng) * ratio });
  } else if (previous) diagramCoordinates.set(name, diagramCoordinates.get(previous.nameZh));
  else if (next) diagramCoordinates.set(name, diagramCoordinates.get(next.nameZh));
  else diagramCoordinates.set(name, { lat: 39.9, lng: 116.4 });
}

const stations = [...occurrences.entries()].map(([nameZh, items]) => {
  const coordinate = coordinateCache.stations[nameZh];
  const districts = [...new Set(items.flatMap((item) => parseDistricts(item.districtNameZh, nameZh)))];
  const sourceIds = [...new Set([...items.map((item) => sourceForLine.get(item.lineId)), "wiki-station-pages"] )];
  return {
    id: stationId(nameZh),
    nameZh,
    districtIds: districts.map((name) => districtIds.get(name)),
    ...(!coordinate?.missing ? { coordinate: { lat: coordinate.lat, lng: coordinate.lng, crs: "WGS84" } } : {}),
    status: nameZh === "八角游乐园" ? "temporarily_closed" : "open",
    sourceIds
  };
}).sort((a, b) => a.id.localeCompare(b.id));

const lineDefinitions = {
  "line-6": { nameZh: "6号线", color: "#B58500", topology: "linear" },
  "line-2": { nameZh: "2号线", color: "#004B87", topology: "circular" },
  "line-1": { nameZh: "1号线", color: "#A4343A", topology: "linear" },
  "line-batong": { nameZh: "八通线", color: "#A4343A", topology: "linear" }
};
const lines = Object.entries(lineDefinitions).map(([id, definition]) => ({
  id,
  ...definition,
  serviceType: "metro",
  status: "open",
  statisticsPolicy: { includeInStationCoverage: true, includeInMileage: true, includeInCompletion: true },
  sourceIds: [sourceForLine.get(id)]
}));

const lineStations = [];
const segments = [];
for (const [lineId, rows] of Object.entries(extracted)) {
  rows.forEach((row, index) => {
    lineStations.push({
      id: lineStationId(lineId, row.nameZh),
      lineId,
      stationId: stationId(row.nameZh),
      displayOrder: index,
      ...(parseOpenedAt(row.openedAtText) ? { openedAt: parseOpenedAt(row.openedAtText) } : {}),
      status: row.nameZh === "八角游乐园" ? "temporarily_closed" : "open",
      sourceIds: [sourceForLine.get(lineId)]
    });
    if (index === 0) return;
    const previous = rows[index - 1];
    segments.push({
      id: `${lineId}.segment-${index - 1}-${index}`,
      lineId,
      fromLineStationId: lineStationId(lineId, previous.nameZh),
      toLineStationId: lineStationId(lineId, row.nameZh),
      distanceM: row.distanceFromPreviousM,
      distanceSourceType: "wikipedia",
      status: "open",
      sourceIds: [sourceForLine.get(lineId)]
    });
  });
  if (lineId === "line-2") {
    const first = rows[0];
    const last = rows.at(-1);
    segments.push({
      id: "line-2.segment-closing",
      lineId,
      fromLineStationId: lineStationId(lineId, last.nameZh),
      toLineStationId: lineStationId(lineId, first.nameZh),
      distanceM: first.distanceFromPreviousM,
      distanceSourceType: "wikipedia",
      status: "open",
      sourceIds: [sourceForLine.get(lineId)]
    });
  }
}

const sharedStations = [
  ["line-6", "line-2", "车公庄"],
  ["line-6", "line-2", "朝阳门"],
  ["line-1", "line-2", "复兴门"],
  ["line-1", "line-2", "建国门"],
  ["line-6", "line-1", "苹果园"]
];
const transferLinks = sharedStations.map(([fromLine, toLine, name], index) => ({
  id: `transfer-${index + 1}`,
  fromLineStationId: lineStationId(fromLine, name),
  toLineStationId: lineStationId(toLine, name),
  type: "in_station",
  sourceIds: [...new Set([sourceForLine.get(fromLine), sourceForLine.get(toLine)])]
}));

const project = ({ lat, lng }) => ({ x: Math.round((lng - 116.05) * 1000), y: Math.round((40.15 - lat) * 1000) });
const diagramNodes = stations.map((station) => ({ stationId: station.id, ...project(diagramCoordinates.get(station.nameZh)) }));
const nodePositions = new Map(diagramNodes.map((node) => [node.stationId, node]));
const lineStationById = new Map(lineStations.map((item) => [item.id, item]));
const diagramSegments = segments.map((segment) => {
  const from = nodePositions.get(lineStationById.get(segment.fromLineStationId).stationId);
  const to = nodePositions.get(lineStationById.get(segment.toLineStationId).stationId);
  return { segmentId: segment.id, path: `M${from.x} ${from.y} L${to.x} ${to.y}` };
});

const network = {
  meta: {
    schemaVersion: "1.0.0",
    datasetVersion: "2026.06.30.1",
    effectiveDate: EFFECTIVE_DATE,
    generatedAt: "2026-08-27T00:00:00+08:00",
    scope: {
      description: "代表性样例：6号线、2号线、1号线及八通线；项目完整范围为官方线路图中的地铁、机场线和有轨电车，不含市郊铁路",
      includedServiceTypes: ["metro", "airport", "tram"],
      excludeSuburbanRail: true,
      officialMapAsScopeReference: true
    }
  },
  sources: [
    ...inputs.map((item) => ({
      id: item.sourceId,
      name: `中文维基百科：${lineDefinitions[item.lineId].nameZh}`,
      type: "wikipedia",
      url: encodeURI(({
        "line-6": "https://zh.wikipedia.org/wiki/北京地铁6号线",
        "line-2": "https://zh.wikipedia.org/wiki/北京地铁2号线",
        "line-1": "https://zh.wikipedia.org/wiki/北京地铁1号线",
        "line-batong": "https://zh.wikipedia.org/wiki/北京地铁八通线"
      })[item.lineId]),
      retrievedAt: SOURCE_DATE,
      effectiveDate: EFFECTIVE_DATE,
      license: "CC BY-SA 4.0",
      notes: "站序、行政区、开通状态及精确到米的站间距主来源"
    })),
    {
      id: "wiki-station-pages",
      name: "中文维基百科车站词条坐标",
      type: "wikipedia",
      url: "https://zh.wikipedia.org/",
      retrievedAt: SOURCE_DATE,
      license: "CC BY-SA 4.0",
      notes: "从线路表格准确车站链接对应的词条，通过 MediaWiki API prop=coordinates 批量获取 WGS84 坐标；逐站标题及 URL 见坐标缓存"
    }
  ],
  districts: districtNames.map((nameZh) => ({ id: districtIds.get(nameZh), nameZh, provinceNameZh: "北京市" })),
  stations,
  lines,
  lineStations,
  segments,
  transferLinks,
  throughServices: [{
    id: "through-line-1-batong",
    nameZh: "1号线—八通线贯通运营",
    lineIds: ["line-1", "line-batong"],
    connectionStationId: stationId("四惠东"),
    sourceIds: ["wiki-line-1", "wiki-line-batong"]
  }],
  diagram: { width: 1200, height: 700, nodes: diagramNodes, segments: diagramSegments }
};

const firstSixSegments = segments.filter((segment) => segment.lineId === "line-6").slice(0, 3).map((segment) => segment.id);
const footprintBase = {
  schemaVersion: "1.0.0",
  datasetVersion: "2026.06.30.1",
  scoringVersion: "1.0.0",
  appVersion: "0.1.0",
  createdAt: "2026-08-27T00:00:00+08:00",
  updatedAt: "2026-08-27T00:00:00+08:00"
};
const validFootprint = {
  ...footprintBase,
  title: "6号线西段示例：中间站仅经过",
  selectedSegmentIds: firstSixSegments,
  stationVisits: [
    { stationId: stationId("金安桥"), visitTypes: ["board_or_alight"] },
    { stationId: stationId("西黄村"), visitTypes: ["board_or_alight"] }
  ],
  notes: "苹果园和杨庄仅经过，因此未列入 stationVisits。"
};
const warningFootprint = {
  ...footprintBase,
  title: "导出前孤立车站警告示例",
  selectedSegmentIds: firstSixSegments,
  stationVisits: [{ stationId: stationId("潞阳"), visitTypes: ["board_or_alight"] }]
};
const invalidFootprint = {
  ...footprintBase,
  title: "无效引用示例",
  selectedSegmentIds: ["segment-does-not-exist"],
  stationVisits: []
};

await fs.mkdir("data/sample", { recursive: true });
await Promise.all([
  fs.writeFile("data/sample/network.json", `${JSON.stringify(network, null, 2)}\n`, "utf8"),
  fs.writeFile("data/sample/footprint.valid.json", `${JSON.stringify(validFootprint, null, 2)}\n`, "utf8"),
  fs.writeFile("data/sample/footprint.warning.json", `${JSON.stringify(warningFootprint, null, 2)}\n`, "utf8"),
  fs.writeFile("data/sample/footprint.invalid.json", `${JSON.stringify(invalidFootprint, null, 2)}\n`, "utf8")
]);
console.log(`生成完成：${stations.length} 个物理车站、${lineStations.length} 个线路站点、${segments.length} 个区间。`);
