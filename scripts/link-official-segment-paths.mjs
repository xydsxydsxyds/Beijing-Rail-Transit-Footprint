import fs from "node:fs/promises";

const network = JSON.parse(await fs.readFile("data/network.json", "utf8"));
const official = JSON.parse(await fs.readFile("data/diagram-hotspots.official.json", "utf8"));
const outputPath = process.argv[2] || "data/diagram-hotspots.json";
const reportPath = "data/reports/diagram-hotspot-validation.json";

const excludedStationNames = new Set();
const officialColor = {
  "line-1": "#c23a30", "line-batong": "#c23a30", "line-2": "#006098", "line-3": "#ce093d",
  "line-4": "#008e9c", "line-daxing": "#008e9c", "line-5": "#a6217f", "line-6": "#d29700",
  "line-7": "#f6c582", "line-8": "#009b6b", "line-9": "#8fc31f", "line-10": "#009bc0",
  "line-11": "#ed796b", "line-12": "#bd6f16", "line-13": "#f9e700", "line-14": "#d5a7a1",
  "line-15": "#5b2c68", "line-16": "#76a32e", "line-17": "#00a9a9", "line-18": "#665794",
  "line-19": "#d6abc1", "line-yizhuang": "#e40077", "line-fangshan": "#e46022", "line-yanfang": "#e46022",
  "line-changping": "#de82b2", "line-s1": "#b35a20", "capital-airport-express": "#a29bbb",
  "daxing-airport-express": "#004a9f", "line-xijiao": "#e50619", "line-yizhuang-t1": "#e5061b"
};

const stationById = new Map(network.stations.map((item) => [item.id, item]));
const lineStationById = new Map(network.lineStations.map((item) => [item.id, item]));
const hotspotByStationId = new Map(official.stationHotspots.map((item) => [item.stationId, item]));
const includedStationHotspots = official.stationHotspots.filter((item) => !excludedStationNames.has(item.stationNameZh));
const includedSegments = network.segments.filter((segment) => {
  const from = stationById.get(lineStationById.get(segment.fromLineStationId).stationId);
  const to = stationById.get(lineStationById.get(segment.toLineStationId).stationId);
  return !excludedStationNames.has(from.nameZh) && !excludedStationNames.has(to.nameZh);
});

const key = ([x, y]) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
const graphs = new Map();
for (const [index, primitive] of official.officialPathPrimitives.entries()) {
  const color = primitive.stroke.toLowerCase();
  if (!graphs.has(color)) graphs.set(color, new Map());
  const graph = graphs.get(color); const a = key(primitive.start); const b = key(primitive.end);
  const weight = Math.hypot(primitive.end[0] - primitive.start[0], primitive.end[1] - primitive.start[1]);
  if (!graph.has(a)) graph.set(a, []); if (!graph.has(b)) graph.set(b, []);
  graph.get(a).push({ to: b, index, weight, reverse: false });
  graph.get(b).push({ to: a, index, weight, reverse: true });
}

function nearestNode(graph, point, maximum = 18) {
  let best = null;
  for (const node of graph.keys()) {
    const [x, y] = node.split(",").map(Number); const distance = Math.hypot(x - point.x, y - point.y);
    if (!best || distance < best.distance) best = { node, distance };
  }
  return best && best.distance <= maximum ? best : null;
}

function shortestPath(graph, start, target) {
  const distances = new Map([[start, 0]]); const previous = new Map(); const unsettled = new Set([start]);
  while (unsettled.size) {
    let current; let currentDistance = Infinity;
    for (const node of unsettled) if (distances.get(node) < currentDistance) { current = node; currentDistance = distances.get(node); }
    unsettled.delete(current); if (current === target) break;
    for (const edge of graph.get(current) || []) {
      const nextDistance = currentDistance + edge.weight;
      if (nextDistance >= (distances.get(edge.to) ?? Infinity)) continue;
      distances.set(edge.to, nextDistance); previous.set(edge.to, { node: current, edge }); unsettled.add(edge.to);
    }
  }
  if (!previous.has(target) && start !== target) return null;
  const edges = []; let cursor = target;
  while (cursor !== start) { const step = previous.get(cursor); if (!step) return null; edges.push(step.edge); cursor = step.node; }
  return { edges: edges.reverse(), length: distances.get(target) || 0 };
}

function reversePrimitive(primitive) {
  if (primitive.type === "line") return `M${primitive.end[0]} ${primitive.end[1]} L${primitive.start[0]} ${primitive.start[1]}`;
  const match = primitive.d.match(/^\s*M\s*(-?[\d.]+)\s+(-?[\d.]+)\s+Q\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$/i);
  if (match) return `M${match[5]} ${match[6]} Q${match[3]} ${match[4]} ${match[1]} ${match[2]}`;
  return primitive.d;
}

const segmentHotspots = []; const unresolvedSegments = [];
for (const segment of includedSegments) {
  const fromStationId = lineStationById.get(segment.fromLineStationId).stationId;
  const toStationId = lineStationById.get(segment.toLineStationId).stationId;
  const from = hotspotByStationId.get(fromStationId); const to = hotspotByStationId.get(toStationId);
  const color = officialColor[segment.lineId]; const graph = graphs.get(color);
  if (!from || !to || !graph) { unresolvedSegments.push({ segmentId: segment.id, reason: !from || !to ? "missing_station_hotspot" : "missing_line_color_graph" }); continue; }
  const start = nearestNode(graph, from); const end = nearestNode(graph, to);
  if (!start || !end) { unresolvedSegments.push({ segmentId: segment.id, lineId: segment.lineId, from: from.stationNameZh, to: to.stationNameZh, reason: "station_not_on_color_graph", startDistance: start?.distance ?? null, endDistance: end?.distance ?? null }); continue; }
  const route = shortestPath(graph, start.node, end.node);
  if (!route || !route.edges.length) { unresolvedSegments.push({ segmentId: segment.id, lineId: segment.lineId, from: from.stationNameZh, to: to.stationNameZh, reason: "no_path_between_stations" }); continue; }
  const pieces = route.edges.map((edge) => {
    const primitive = official.officialPathPrimitives[edge.index];
    return { primitiveIndex: edge.index, reverse: edge.reverse, d: edge.reverse ? reversePrimitive(primitive) : primitive.d };
  });
  segmentHotspots.push({
    segmentId: segment.id, lineId: segment.lineId, fromStationId, toStationId,
    stroke: color, hitWidth: 12, pathPieces: pieces, path: pieces.map((piece) => piece.d).join(" "),
    routeLength: Number(route.length.toFixed(3)), endpointError: { from: Number(start.distance.toFixed(3)), to: Number(end.distance.toFixed(3)) },
    recognitionStatus: "official_topology_matched"
  });
}

const expectedStationIds = new Set(network.stations.filter((station) => !excludedStationNames.has(station.nameZh)).map((station) => station.id));
const duplicateSegmentIds = segmentHotspots.map((item) => item.segmentId).filter((id, index, all) => all.indexOf(id) !== index);
const ready = includedStationHotspots.length === expectedStationIds.size && segmentHotspots.length === includedSegments.length && !duplicateSegmentIds.length;
const document = {
  schemaVersion: "1.0.0", datasetVersion: network.meta.datasetVersion, status: ready ? "ready" : "needs_review",
  effectiveScope: { operatingStationsOnly: true, excludedStationNames: [...excludedStationNames], excludedDeferredStations: ["陶然桥", "老观里"] },
  coordinateSystem: official.coordinateSystem, stationHotspots: includedStationHotspots, segmentHotspots,
  source: official.source
};
const report = {
  generatedAt: new Date().toISOString(), status: ready ? "passed" : "failed",
  expected: { operatingPhysicalStations: expectedStationIds.size, operatingSegments: includedSegments.length },
  actual: { stationHotspots: includedStationHotspots.length, segmentHotspots: segmentHotspots.length },
  checks: { allOperatingStationsAssigned: includedStationHotspots.length === expectedStationIds.size, allOperatingSegmentsTraced: segmentHotspots.length === includedSegments.length, noDuplicateSegmentIds: duplicateSegmentIds.length === 0, maximumEndpointError: segmentHotspots.length ? Math.max(...segmentHotspots.flatMap((item) => [item.endpointError.from, item.endpointError.to])) : null },
  unresolvedSegments, duplicateSegmentIds, safeToUseInFrontend: ready
};
await Promise.all([fs.writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8"), fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")]);
console.log(`正式热点：${includedStationHotspots.length}/${expectedStationIds.size} 站，${segmentHotspots.length}/${includedSegments.length} 区间。`);
if (!ready) { console.error(`尚有 ${unresolvedSegments.length} 个区间无法关联；详情见 ${reportPath}`); process.exitCode = 1; }
