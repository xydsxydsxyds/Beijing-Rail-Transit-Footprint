import fs from "node:fs/promises";

const hotspots = JSON.parse(await fs.readFile("data/diagram-hotspots.json", "utf8"));
const network = JSON.parse(await fs.readFile("data/network.json", "utf8"));
const assignedStations = hotspots.stationHotspots.filter((item) => item.stationId);
const assignedSegments = hotspots.segmentHotspots.filter((item) => item.segmentId);
const stationIds = new Set(network.stations.map((item) => item.id));
const segmentIds = new Set(network.segments.map((item) => item.id));
const errors = [];

if (hotspots.status !== "ready") errors.push(`热点状态为 ${hotspots.status}，尚未达到 ready`);
if (assignedStations.length !== network.stations.length) errors.push(`已关联车站 ${assignedStations.length}/${network.stations.length}`);
if (assignedSegments.length !== network.segments.length) errors.push(`已关联区间 ${assignedSegments.length}/${network.segments.length}`);
for (const item of assignedStations) if (!stationIds.has(item.stationId)) errors.push(`未知 stationId：${item.stationId}`);
for (const item of assignedSegments) if (!segmentIds.has(item.segmentId)) errors.push(`未知 segmentId：${item.segmentId}`);

if (errors.length) {
  console.error(`热点校验未通过：\n- ${errors.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`热点校验通过：${assignedStations.length} 个车站、${assignedSegments.length} 个区间。`);
}
