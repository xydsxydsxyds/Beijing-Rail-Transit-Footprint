import crypto from "node:crypto";
import fs from "node:fs/promises";

const manifest = JSON.parse(await fs.readFile("data/sources/line-manifest.json", "utf8"));
const source = JSON.parse(await fs.readFile("data/intermediate/network-source.json", "utf8"));
const coordinateCache = JSON.parse(await fs.readFile("data/raw/openstreetmap/network-station-coordinates.json", "utf8")
  .catch(() => fs.readFile("data/raw/wikipedia/network-station-coordinates.json", "utf8")));
const revisionIndex = JSON.parse(await fs.readFile("data/raw/wikipedia/lines/revision-index.json", "utf8"));

const districtNames = ["东城区", "西城区", "朝阳区", "海淀区", "丰台区", "石景山区", "门头沟区", "房山区", "通州区", "顺义区", "昌平区", "大兴区", "怀柔区", "平谷区", "密云区", "延庆区", "广阳区"];
const districtId = (name) => `district-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 10)}`;
const stationId = (name) => `station-${[...name].map((c) => c.codePointAt(0).toString(16)).join("-")}`;
const lineStationId = (lineId, name) => `${lineId}.${stationId(name)}`;
const sourceId = (lineId) => `wiki-${lineId}`;

function districtsFor(text, name) {
  const normalized = text.replaceAll("陽", "阳").replaceAll("區", "区").replaceAll("門", "门").replaceAll("興", "兴").replaceAll("順", "顺").replaceAll("義", "义").replaceAll("廣", "广");
  const found = districtNames.filter((district) => normalized.includes(district));
  if (found.length) return found;
  const known = { 东直门: "东城区", 西直门: "西城区", 北京南站: "丰台区", 草桥: "丰台区", 大兴新城: "大兴区", 大兴机场: "广阳区" }[name];
  if (known) return [known];
  return [];
}

// 首都机场线表格采用环回运行顺序，转换为可连通的专项图结构。
const airport = source.lines["capital-airport-express"];
const airportByName = new Map(airport.map((row) => [row.nameZh, row]));
const airportOrder = ["北新桥", "东直门", "三元桥", "3号航站楼", "2号航站楼"];
source.lines["capital-airport-express"] = airportOrder.map((name) => airportByName.get(name));

// 运营口径以官方线网图实际设站为准：福寿岭不属于正式运营车站；
// 17号线在广渠门外仅通过、不办理上下车，合并相邻两段里程。
source.lines["line-1"] = source.lines["line-1"].filter((row) => row.nameZh !== "福寿岭");
const line17GuangqumenwaiIndex = source.lines["line-17"].findIndex((row) => row.nameZh === "广渠门外");
if (line17GuangqumenwaiIndex > 0 && line17GuangqumenwaiIndex < source.lines["line-17"].length - 1) {
  const passThrough = source.lines["line-17"][line17GuangqumenwaiIndex];
  const nextStop = source.lines["line-17"][line17GuangqumenwaiIndex + 1];
  nextStop.distanceFromPreviousM += passThrough.distanceFromPreviousM;
  source.lines["line-17"].splice(line17GuangqumenwaiIndex, 1);
}

const occurrences = new Map();
for (const [lineId, rows] of Object.entries(source.lines)) {
  rows.forEach((row) => {
    if (!row) throw new Error(`${lineId}: 首都机场线专项站序缺站`);
    if (!occurrences.has(row.nameZh)) occurrences.set(row.nameZh, []);
    occurrences.get(row.nameZh).push({ lineId, row });
  });
}

const stations = [...occurrences].map(([nameZh, items]) => {
  const coordinate = coordinateCache.stations[nameZh];
  const districtValues = [...new Set(items.flatMap(({ row }) => districtsFor(row.districtNameZh, nameZh)))];
  if (!districtValues.length) throw new Error(`${nameZh}: 无法从 ${items.map(({ row }) => `“${row.districtNameZh}”`).join("、")} 识别行政区`);
  const districtIds = districtValues.map(districtId);
  return {
    id: stationId(nameZh), nameZh, districtIds,
    ...(coordinate && !coordinate.missing ? { coordinate: { lat: coordinate.lat, lng: coordinate.lng, crs: "WGS84" } } : {}),
    status: nameZh === "八角游乐园" ? "temporarily_closed" : "open",
    sourceIds: [...new Set(items.map(({ lineId }) => sourceId(lineId)).concat(coordinate?.coordinateSource === "openstreetmap" ? "osm-stations" : "wiki-station-pages"))]
  };
}).sort((a, b) => a.id.localeCompare(b.id));

const lines = manifest.lines.map((line) => ({
  id: line.id, nameZh: line.nameZh, color: line.color, serviceType: line.serviceType,
  topology: line.topology === "special" ? "branched" : line.topology,
  status: "open", statisticsPolicy: line.statisticsPolicy, sourceIds: [sourceId(line.id)]
}));

const lineStations = [];
const segments = [];
function addSegment(lineId, from, to, distanceM, suffix, extra = {}) {
  if (!Number.isFinite(distanceM) || distanceM <= 0 || distanceM * 2 % 1 !== 0) throw new Error(`${lineId} ${from.nameZh}→${to.nameZh}: 非法站距 ${distanceM}`);
  segments.push({
    id: `${lineId}.segment-${suffix}`, lineId,
    fromLineStationId: lineStationId(lineId, from.nameZh), toLineStationId: lineStationId(lineId, to.nameZh),
    distanceM, distanceSourceType: "wikipedia", distanceCalculation: "direct", ...extra, status: "open", sourceIds: [sourceId(lineId)]
  });
}

for (const line of manifest.lines) {
  const rows = source.lines[line.id];
  rows.forEach((row, index) => lineStations.push({
    id: lineStationId(line.id, row.nameZh), lineId: line.id, stationId: stationId(row.nameZh), displayOrder: index,
    ...(row.openedAt ? { openedAt: row.openedAt } : {}),
    status: row.nameZh === "八角游乐园" ? "temporarily_closed" : "open", sourceIds: [sourceId(line.id)]
  }));
  if (line.id === "capital-airport-express") continue;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const useAverage = ["line-xijiao", "line-yizhuang-t1"].includes(line.id) && row.directionalDistancesM?.length === 2;
    const distanceM = useAverage ? (row.directionalDistancesM[0] + row.directionalDistancesM[1]) / 2 : row.distanceFromPreviousM;
    addSegment(line.id, rows[index - 1], row, distanceM, `${index - 1}-${index}`, useAverage ? { directionalDistancesM: row.directionalDistancesM, distanceCalculation: "directional_average" } : {});
  }
  if (line.topology === "circular") addSegment(line.id, rows.at(-1), rows[0], rows[0].distanceFromPreviousM, "closing");
}

const cap = Object.fromEntries(source.lines["capital-airport-express"].map((r) => [r.nameZh, r]));
addSegment("capital-airport-express", cap["北新桥"], cap["东直门"], airportByName.get("北新桥").distanceFromPreviousM, "beixinqiao-dongzhimen");
addSegment("capital-airport-express", cap["东直门"], cap["三元桥"], airportByName.get("东直门").distanceFromPreviousM, "dongzhimen-sanyuanqiao");
addSegment("capital-airport-express", cap["三元桥"], cap["3号航站楼"], airportByName.get("3号航站楼").distanceFromPreviousM, "sanyuanqiao-t3", { distanceCalculation: "special_combination" });
addSegment("capital-airport-express", cap["3号航站楼"], cap["2号航站楼"], airportByName.get("2号航站楼").distanceFromPreviousM, "t3-t2", { distanceCalculation: "special_combination" });
addSegment("capital-airport-express", cap["2号航站楼"], cap["三元桥"], airportByName.get("三元桥").distanceFromPreviousM, "t2-sanyuanqiao", { distanceCalculation: "special_combination" });

const shared = [...occurrences].filter(([, items]) => new Set(items.map((x) => x.lineId)).size > 1);
const outOfStationNames = new Set(["木樨地", "大钟寺"]);
const transferLinks = [];
for (const [stationNameZh, items] of shared) {
  const lineIds = [...new Set(items.map((x) => x.lineId))];
  for (let i = 0; i < lineIds.length; i += 1) {
    for (let j = i + 1; j < lineIds.length; j += 1) {
      const [fromLine, toLine] = [lineIds[i], lineIds[j]];
      transferLinks.push({
        id: `transfer-${stationId(stationNameZh).slice(8)}-${fromLine}-${toLine}`,
        fromLineStationId: lineStationId(fromLine, stationNameZh), toLineStationId: lineStationId(toLine, stationNameZh),
        type: outOfStationNames.has(stationNameZh) ? "out_of_station" : "in_station",
        sourceIds: [sourceId(fromLine), sourceId(toLine)]
      });
    }
  }
}
const transferReview = shared.map(([stationNameZh, items]) => ({
  stationId: stationId(stationNameZh), stationNameZh,
  lineIds: [...new Set(items.map((x) => x.lineId))],
  classification: outOfStationNames.has(stationNameZh) ? "out_of_station" : "in_station"
}));

const positionFor = (station) => {
  const c = station.coordinate || { lat: 39.9, lng: 116.4 };
  return { x: Math.round((c.lng - 115.4) * 1000), y: Math.round((41.1 - c.lat) * 1000) };
};
const diagramNodes = stations.map((station) => ({ stationId: station.id, ...positionFor(station) }));
const positions = new Map(diagramNodes.map((node) => [node.stationId, node]));
const ls = new Map(lineStations.map((item) => [item.id, item]));
const diagramSegments = segments.map((segment) => {
  const from = positions.get(ls.get(segment.fromLineStationId).stationId);
  const to = positions.get(ls.get(segment.toLineStationId).stationId);
  return { segmentId: segment.id, path: `M${from.x} ${from.y} L${to.x} ${to.y}` };
});

const retrievedAt = revisionIndex.generatedAt?.slice(0, 10) || "2026-08-28";
const network = {
  meta: { schemaVersion: "1.0.0", datasetVersion: manifest.manifestVersion, effectiveDate: manifest.effectiveDate,
    generatedAt: new Date().toISOString(), scope: { description: manifest.scope.reference, includedServiceTypes: ["metro", "airport", "tram"], excludeSuburbanRail: true, officialMapAsScopeReference: true } },
  sources: [
    ...manifest.lines.map((line) => ({ id: sourceId(line.id), name: `中文维基百科：${line.nameZh}`, type: "wikipedia", url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(line.wikipediaPageTitle)}`, retrievedAt, effectiveDate: manifest.effectiveDate, license: "CC BY-SA 4.0", notes: "当前页面线路表：站序、行政区、开通状态及米级站间距" })),
    { id: "wiki-station-pages", name: "中文维基百科车站词条坐标", type: "wikipedia", url: "https://zh.wikipedia.org/", retrievedAt, license: "CC BY-SA 4.0", notes: "OpenStreetMap 未匹配站点的坐标回退来源" },
    { id: "osm-stations", name: "OpenStreetMap 轨道交通车站坐标", type: "openstreetmap", url: "https://www.openstreetmap.org/", retrievedAt: new Date().toISOString().slice(0, 10), license: "ODbL 1.0", notes: "通过 Overpass API 批量提取 railway=station 等站点要素；按中文站名与轨道交通标签高置信度匹配" }
  ],
  districts: districtNames.filter((name) => stations.some((s) => s.districtIds.includes(districtId(name)))).map((nameZh) => ({ id: districtId(nameZh), nameZh, provinceNameZh: nameZh === "广阳区" ? "河北省" : "北京市" })),
  stations, lines, lineStations, segments, transferLinks,
  throughServices: manifest.throughServices.map((item) => ({ id: item.id, nameZh: item.nameZh, lineIds: item.lineIds, connectionStationId: stationId(item.connectionStationNameZh), sourceIds: item.lineIds.map(sourceId) })),
  diagram: { width: 1600, height: 1000, nodes: diagramNodes, segments: diagramSegments }
};

await fs.mkdir("data/reports", { recursive: true });
await Promise.all([
  fs.writeFile("data/network.json", `${JSON.stringify(network, null, 2)}\n`, "utf8"),
  fs.writeFile("data/reports/transfer-review.json", `${JSON.stringify({ generatedAt: new Date().toISOString(), count: transferReview.length, stations: transferReview }, null, 2)}\n`, "utf8")
]);
console.log(`全网基础数据：${lines.length} 条线路，${stations.length} 个物理车站，${lineStations.length} 个线路站点，${segments.length} 个区间。`);
console.log(`坐标缺失：${stations.filter((s) => !s.coordinate).length}；换乘站：${transferReview.length}，换乘关系：${transferLinks.length}。`);
