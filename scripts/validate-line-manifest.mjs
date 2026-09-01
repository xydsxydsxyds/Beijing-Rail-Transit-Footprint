import fs from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const manifestPath = process.argv[2] || "data/sources/line-manifest.json";
const [manifest, schema] = await Promise.all([
  fs.readFile(manifestPath, "utf8").then(JSON.parse),
  fs.readFile("schemas/line-manifest.schema.json", "utf8").then(JSON.parse)
]);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const errors = [];
if (!validate(manifest)) {
  errors.push(...validate.errors.map((item) => `${item.instancePath || "/"}: ${item.message}`));
}

function duplicates(values) {
  const seen = new Set();
  return [...new Set(values.filter((value) => seen.has(value) || !seen.add(value)))];
}
for (const [label, values] of [
  ["线路ID", manifest.lines.map((line) => line.id)],
  ["线路名称", manifest.lines.map((line) => line.nameZh)],
  ["Wikipedia词条", manifest.lines.map((line) => line.wikipediaPageTitle)],
  ["快照文件", manifest.lines.map((line) => line.snapshotFile)],
  ["贯通服务ID", manifest.throughServices.map((item) => item.id)]
]) {
  for (const value of duplicates(values)) errors.push(`${label}重复：${value}`);
}

const lineIds = new Set(manifest.lines.map((line) => line.id));
for (const service of manifest.throughServices) {
  for (const lineId of service.lineIds) if (!lineIds.has(lineId)) errors.push(`${service.id} 引用了不存在的线路 ${lineId}`);
}
const requiredTypes = ["metro", "airport", "tram"];
for (const type of requiredTypes) if (!manifest.scope.includedServiceTypes.includes(type)) errors.push(`范围缺少线路类型 ${type}`);
if (!manifest.scope.excludedServiceTypes.includes("suburban_rail")) errors.push("范围必须明确排除 suburban_rail");

const capital = manifest.lines.find((line) => line.id === "capital-airport-express");
if (!capital || !capital.statisticsPolicy.includeInMileage || !capital.statisticsPolicy.includeInCompletion || capital.statisticsPolicy.specialRule !== "capital-airport-combination-v1") {
  errors.push("首都机场线必须启用里程与完成度统计，并配置 capital-airport-combination-v1");
}
for (const [serviceId, expectedLines, station] of [
  ["through-line-1-batong", ["line-1", "line-batong"], "四惠东"],
  ["through-line-4-daxing", ["line-4", "line-daxing"], "公益西桥"]
]) {
  const service = manifest.throughServices.find((item) => item.id === serviceId);
  if (!service || station !== service.connectionStationNameZh || expectedLines.some((id) => !service.lineIds.includes(id))) {
    errors.push(`贯通服务配置不完整：${serviceId}`);
  }
}

if (errors.length) {
  errors.forEach((message) => console.error(`错误：${message}`));
  console.error(`清单校验失败：${errors.length} 个错误。`);
  process.exitCode = 1;
} else {
  const counts = Object.groupBy(manifest.lines, (line) => line.serviceType);
  console.log(`清单校验通过：${manifest.lines.length} 条线路（地铁 ${counts.metro?.length || 0}，机场线 ${counts.airport?.length || 0}，有轨电车 ${counts.tram?.length || 0}），${manifest.throughServices.length} 组贯通运营。`);
}
