import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { missingContinuousEndpoints } from "../src/footprint-io.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const networkSchemaPath = path.join(projectRoot, "schemas", "network.schema.json");
const footprintSchemaPath = path.join(projectRoot, "schemas", "footprint.schema.json");

function issue(level, code, location, message) {
  return { level, code, location, message };
}

function duplicateValues(items, selector = (value) => value) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    const value = selector(item);
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function indexById(items) {
  return new Map(items.map((item) => [item.id, item]));
}

function checkUniqueIds(collectionName, items, issues) {
  for (const id of duplicateValues(items, (item) => item.id)) {
    issues.push(issue("error", "duplicate_id", collectionName, `ID 重复：${id}`));
  }
}

function checkRefs(owner, ids, target, targetName, issues) {
  for (const id of ids) {
    if (!target.has(id)) {
      issues.push(issue("error", "missing_reference", owner, `引用了不存在的${targetName}：${id}`));
    }
  }
}

function checkLineTopology(line, lineStations, segments, issues) {
  const openStations = lineStations.filter((item) => item.lineId === line.id && item.status !== "planned");
  const stationIds = new Set(openStations.map((item) => item.id));
  if (stationIds.size < 2) return;

  const adjacency = new Map([...stationIds].map((id) => [id, new Set()]));
  for (const segment of segments.filter((item) => item.lineId === line.id && item.status !== "planned")) {
    if (!stationIds.has(segment.fromLineStationId) || !stationIds.has(segment.toLineStationId)) continue;
    adjacency.get(segment.fromLineStationId).add(segment.toLineStationId);
    adjacency.get(segment.toLineStationId).add(segment.fromLineStationId);
  }

  const start = stationIds.values().next().value;
  const visited = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    for (const next of adjacency.get(current)) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  if (visited.size !== stationIds.size) {
    const missing = [...stationIds].filter((id) => !visited.has(id));
    issues.push(issue("error", "disconnected_line", `lines.${line.id}`, `运营拓扑不连通；不可达线路站点：${missing.join(", ")}`));
    return;
  }

  const degrees = [...adjacency.values()].map((neighbors) => neighbors.size);
  if (line.topology === "circular" && degrees.some((degree) => degree !== 2)) {
    issues.push(issue("error", "invalid_circular_topology", `lines.${line.id}`, "环线每个运营线路站点必须恰好连接两个相邻站点"));
  }
  if (line.topology === "linear") {
    const endpoints = degrees.filter((degree) => degree === 1).length;
    const invalidMiddle = degrees.some((degree) => degree < 1 || degree > 2);
    if (endpoints !== 2 || invalidMiddle) {
      issues.push(issue("error", "invalid_linear_topology", `lines.${line.id}`, "线性线路必须有且仅有两个度为 1 的端点，其余站点的度必须为 2"));
    }
  }
}

export async function createSchemaValidators() {
  const [networkSchema, footprintSchema] = await Promise.all([
    fs.readFile(networkSchemaPath, "utf8").then(JSON.parse),
    fs.readFile(footprintSchemaPath, "utf8").then(JSON.parse)
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return {
    network: ajv.compile(networkSchema),
    footprint: ajv.compile(footprintSchema)
  };
}

function schemaIssues(validator, data) {
  if (validator(data)) return [];
  return validator.errors.map((error) => issue(
    "error",
    `schema_${error.keyword}`,
    error.instancePath || "/",
    error.message ?? "Schema 校验失败"
  ));
}

export function validateNetworkSemantics(network) {
  const issues = [];
  const collections = ["sources", "districts", "stations", "lines", "lineStations", "segments", "transferLinks", "throughServices"];
  for (const name of collections) checkUniqueIds(name, network[name], issues);

  const sources = indexById(network.sources);
  const districts = indexById(network.districts);
  const stations = indexById(network.stations);
  const lines = indexById(network.lines);
  const lineStations = indexById(network.lineStations);
  const segments = indexById(network.segments);

  const sourcedCollections = ["stations", "lines", "lineStations", "segments", "transferLinks", "throughServices"];
  for (const name of sourcedCollections) {
    network[name].forEach((item, index) => checkRefs(`${name}[${index}].sourceIds`, item.sourceIds, sources, "数据来源", issues));
  }

  network.stations.forEach((station, index) => {
    checkRefs(`stations[${index}].districtIds`, station.districtIds, districts, "行政区", issues);
    if (station.status === "open" && !station.coordinate) {
      issues.push(issue("warning", "missing_coordinate", `stations[${index}].coordinate`, `运营车站 ${station.id} 暂缺地理坐标，地理极限统计将忽略该站`));
    }
  });

  network.lineStations.forEach((item, index) => {
    checkRefs(`lineStations[${index}].lineId`, [item.lineId], lines, "线路", issues);
    checkRefs(`lineStations[${index}].stationId`, [item.stationId], stations, "物理车站", issues);
  });

  const undirectedSegments = new Map();
  network.segments.forEach((segment, index) => {
    const owner = `segments[${index}]`;
    checkRefs(`${owner}.lineId`, [segment.lineId], lines, "线路", issues);
    checkRefs(`${owner}.fromLineStationId`, [segment.fromLineStationId], lineStations, "线路站点", issues);
    checkRefs(`${owner}.toLineStationId`, [segment.toLineStationId], lineStations, "线路站点", issues);
    if (segment.fromLineStationId === segment.toLineStationId) {
      issues.push(issue("error", "self_loop", owner, "区间两端不能是同一个线路站点"));
    }
    const from = lineStations.get(segment.fromLineStationId);
    const to = lineStations.get(segment.toLineStationId);
    if (from && from.lineId !== segment.lineId) issues.push(issue("error", "line_mismatch", owner, "起点线路站点不属于区间声明的线路"));
    if (to && to.lineId !== segment.lineId) issues.push(issue("error", "line_mismatch", owner, "终点线路站点不属于区间声明的线路"));
    const pair = [segment.fromLineStationId, segment.toLineStationId].sort().join("::");
    const key = `${segment.lineId}::${pair}`;
    if (undirectedSegments.has(key)) {
      issues.push(issue("error", "duplicate_segment", owner, `与区间 ${undirectedSegments.get(key)} 重复`));
    } else {
      undirectedSegments.set(key, segment.id);
    }
  });

  network.transferLinks.forEach((link, index) => {
    const owner = `transferLinks[${index}]`;
    checkRefs(`${owner}.fromLineStationId`, [link.fromLineStationId], lineStations, "线路站点", issues);
    checkRefs(`${owner}.toLineStationId`, [link.toLineStationId], lineStations, "线路站点", issues);
    if (link.fromLineStationId === link.toLineStationId) issues.push(issue("error", "self_transfer", owner, "换乘关系两端不能相同"));
    const from = lineStations.get(link.fromLineStationId);
    const to = lineStations.get(link.toLineStationId);
    if (from && to && from.lineId === to.lineId) issues.push(issue("error", "same_line_transfer", owner, "换乘关系必须连接不同线路"));
    if (link.type === "in_station" && from && to && from.stationId !== to.stationId) {
      issues.push(issue("error", "invalid_in_station_transfer", owner, "站内换乘两端必须指向同一物理车站"));
    }
  });

  network.throughServices.forEach((service, index) => {
    const owner = `throughServices[${index}]`;
    checkRefs(`${owner}.lineIds`, service.lineIds, lines, "线路", issues);
    checkRefs(`${owner}.connectionStationId`, [service.connectionStationId], stations, "物理车站", issues);
    for (const lineId of service.lineIds) {
      const found = network.lineStations.some((item) => item.lineId === lineId && item.stationId === service.connectionStationId);
      if (!found) issues.push(issue("error", "invalid_through_connection", owner, `贯通连接站不属于线路 ${lineId}`));
    }
  });

  for (const line of network.lines) checkLineTopology(line, network.lineStations, network.segments, issues);

  const diagramStationIds = network.diagram.nodes.map((item) => item.stationId);
  for (const id of duplicateValues(diagramStationIds)) issues.push(issue("error", "duplicate_diagram_node", "diagram.nodes", `车站布局重复：${id}`));
  checkRefs("diagram.nodes", diagramStationIds, stations, "物理车站", issues);
  for (const station of network.stations.filter((item) => item.status === "open")) {
    if (!diagramStationIds.includes(station.id)) issues.push(issue("error", "missing_diagram_node", "diagram.nodes", `缺少运营车站布局：${station.id}`));
  }

  const diagramSegmentIds = network.diagram.segments.map((item) => item.segmentId);
  for (const id of duplicateValues(diagramSegmentIds)) issues.push(issue("error", "duplicate_diagram_segment", "diagram.segments", `区间布局重复：${id}`));
  checkRefs("diagram.segments", diagramSegmentIds, segments, "区间", issues);
  for (const segment of network.segments.filter((item) => item.status === "open")) {
    if (!diagramSegmentIds.includes(segment.id)) issues.push(issue("error", "missing_diagram_segment", "diagram.segments", `缺少运营区间布局：${segment.id}`));
  }

  for (const line of network.lines) {
    if ((line.id.includes("capital-airport") || line.nameZh.includes("首都机场")) &&
        line.statisticsPolicy.specialRule !== "capital-airport-combination-v1") {
      issues.push(issue("error", "capital_airport_rule_missing", `lines.${line.id}`, "首都机场线必须使用 capital-airport-combination-v1 专项里程规则"));
    }
  }

  return issues;
}

export function validateFootprintSemantics(footprint, network) {
  const issues = [];
  const segments = indexById(network.segments);
  const stations = indexById(network.stations);
  if (footprint.datasetVersion !== network.meta.datasetVersion) {
    issues.push(issue("error", "dataset_version_mismatch", "datasetVersion", `足迹使用 ${footprint.datasetVersion}，线网数据为 ${network.meta.datasetVersion}`));
  }
  checkRefs("selectedSegmentIds", footprint.selectedSegmentIds, segments, "区间", issues);
  const stationIds = footprint.stationVisits.map((visit) => visit.stationId);
  checkRefs("stationVisits", stationIds, stations, "物理车站", issues);
  for (const id of duplicateValues(stationIds)) issues.push(issue("error", "duplicate_station_visit", "stationVisits", `同一物理车站重复记录：${id}`));

  const riddenLineStationIds = new Set();
  for (const segmentId of footprint.selectedSegmentIds) {
    const segment = segments.get(segmentId);
    if (!segment) continue;
    riddenLineStationIds.add(segment.fromLineStationId);
    riddenLineStationIds.add(segment.toLineStationId);
  }
  const adjacentStationIds = new Set(
    network.lineStations
      .filter((item) => riddenLineStationIds.has(item.id))
      .map((item) => item.stationId)
  );
  for (const stationId of stationIds) {
    if (stations.has(stationId) && !adjacentStationIds.has(stationId)) {
      issues.push(issue("warning", "isolated_station_visit", "stationVisits", `到访车站 ${stationId} 不邻接任何已乘区间；请在导出报告前确认`));
    }
  }
  for (const missing of missingContinuousEndpoints(footprint, network)) {
    const message = missing.kind === "closed_loop_without_visit"
      ? `${missing.groupName}的闭合已乘区间未标记任何到访车站`
      : `${missing.groupName}连续已乘区间的端点站 ${missing.stationName} 未标记到访`;
    issues.push(issue("warning", "continuous_endpoint_not_visited", "stationVisits", message));
  }
  return issues;
}

export async function validateData(network, footprint) {
  const validators = await createSchemaValidators();
  const issues = schemaIssues(validators.network, network);
  if (!issues.length) issues.push(...validateNetworkSemantics(network));
  if (footprint !== undefined) {
    const footprintSchemaIssues = schemaIssues(validators.footprint, footprint);
    issues.push(...footprintSchemaIssues);
    if (!footprintSchemaIssues.length && !issues.some((item) => item.level === "error")) {
      issues.push(...validateFootprintSemantics(footprint, network));
    }
  }
  return issues;
}
