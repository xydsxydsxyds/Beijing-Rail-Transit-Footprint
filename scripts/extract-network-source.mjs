import fs from "node:fs/promises";
import path from "node:path";
import { extractLine } from "./extract-wikipedia-lines.mjs";

const manifestPath = "data/sources/line-manifest.json";
const snapshotDir = "data/raw/wikipedia/lines";
const outputPath = "data/intermediate/network-source.json";

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const effectiveDate = manifest.effectiveDate;
const lines = {};
const explicitlyExcludedStations = new Set(["line-1|53號站", "line-17|北七家"]);

function deduplicate(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.nameZh}|${row.cumulativeM ?? ""}|${row.distanceFromPreviousM}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

for (const definition of manifest.lines) {
  const file = path.join(snapshotDir, definition.snapshotFile);
  const extracted = deduplicate(await extractLine(file, definition.id));
  // 合并单元格或多层表头可能使部分运营站没有逐行日期；仅排除明确晚于截止日的记录。
  const explicitlyNotOpen = /建设中|尚未开通|暂缓|有待确定|规划|预计/;
  lines[definition.id] = extracted.filter((row) =>
    (!row.openedAt || row.openedAt <= effectiveDate)
      && !explicitlyNotOpen.test(row.openedAtText)
      && !explicitlyExcludedStations.has(`${definition.id}|${row.nameZh}`)
  );
}

function prependConnection(targetLineId, sourceLineId, stationName) {
  if (lines[targetLineId].some((row) => row.nameZh === stationName)) return;
  const source = lines[sourceLineId].find((row) => row.nameZh === stationName);
  if (!source) throw new Error(`${targetLineId}: 无法从 ${sourceLineId} 找到贯通站 ${stationName}`);
  lines[targetLineId].unshift({
    ...source,
    lineId: targetLineId,
    distanceFromPreviousM: 0,
    inheritedFromLineId: sourceLineId
  });
}

prependConnection("line-batong", "line-1", "四惠东");
prependConnection("line-daxing", "line-4", "公益西桥");

const output = {
  schemaVersion: "1.0.0",
  datasetVersion: manifest.manifestVersion,
  effectiveDate,
  generatedAt: new Date().toISOString(),
  lines
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

const counts = Object.entries(lines).map(([lineId, rows]) => `${lineId}=${rows.length}`).join(", ");
console.log(`已生成 ${outputPath}：${Object.keys(lines).length} 条线路。`);
console.log(counts);
