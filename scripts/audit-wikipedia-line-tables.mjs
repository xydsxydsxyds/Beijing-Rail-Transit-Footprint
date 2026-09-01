import fs from "node:fs/promises";
import path from "node:path";
import { extractLine } from "./extract-wikipedia-lines.mjs";

const manifest = JSON.parse(await fs.readFile("data/sources/line-manifest.json", "utf8"));
const report = { generatedAt: new Date().toISOString(), effectiveDate: manifest.effectiveDate, summary: {}, lines: [] };
for (const line of manifest.lines) {
  const file = path.join("data/raw/wikipedia/lines", line.snapshotFile);
  try {
    const rows = await extractLine(file, line.id);
    if (line.topology === "special") throw new Error("特殊拓扑需要专用适配器");
    const operationalRows = rows.filter((row) => row.openedAt && row.openedAt <= manifest.effectiveDate);
    const distinct = new Set(operationalRows.map((row) => row.nameZh));
    const missingLinks = operationalRows.filter((row) => !row.wikipediaPageTitle).map((row) => row.nameZh);
    const nonPositiveDistances = operationalRows.slice(line.topology === "circular" ? 0 : 1).filter((row) => !(row.distanceFromPreviousM > 0)).map((row) => row.nameZh);
    report.lines.push({
      id: line.id,
      nameZh: line.nameZh,
      status: missingLinks.length || nonPositiveDistances.length ? "needs-review" : "extractable",
      sourceRowCount: rows.length,
      rowCount: operationalRows.length,
      distinctStationCount: distinct.size,
      duplicateRowCount: rows.length - distinct.size,
      missingLinkStations: missingLinks,
      nonPositiveDistanceStations: nonPositiveDistances
    });
  } catch (error) {
    report.lines.push({ id: line.id, nameZh: line.nameZh, status: "adapter-required", error: error.message });
  }
}
report.summary = Object.fromEntries(Object.entries(Object.groupBy(report.lines, (line) => line.status)).map(([key, value]) => [key, value.length]));
await fs.mkdir("data/reports", { recursive: true });
await fs.writeFile("data/reports/line-source-audit.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report.summary));
for (const line of report.lines.filter((item) => item.status !== "extractable")) console.log(`${line.status}: ${line.id} ${line.error || "需复核"}`);
