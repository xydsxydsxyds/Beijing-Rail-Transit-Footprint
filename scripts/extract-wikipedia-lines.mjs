import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";

function readCell($, cell) {
  const clone = $(cell).clone();
  clone.find("sup,style,link").remove();
  const text = clone.text().replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  const links = clone.find("a[href^='/wiki/']").map((_, link) => ({
    text: $(link).text().replace(/\s+/g, " ").trim(),
    title: $(link).attr("title") || null,
    href: $(link).attr("href")
  })).get();
  return { text, links };
}

function expandRows($, table) {
  const pending = [];
  const output = [];
  $(table).find(":scope > tbody > tr, :scope > tr").each((_, row) => {
    const values = [];
    for (let col = 0; col < pending.length; col += 1) {
      if (pending[col]?.remaining > 0) values[col] = pending[col].value;
    }
    let col = 0;
    $(row).children("th,td").each((__, cell) => {
      while (values[col] !== undefined) col += 1;
      const value = readCell($, cell);
      const colspan = Number($(cell).attr("colspan") || 1);
      const rowspan = Number($(cell).attr("rowspan") || 1);
      for (let offset = 0; offset < colspan; offset += 1) {
        values[col + offset] = value;
        if (rowspan > 1) pending[col + offset] = { value, remaining: rowspan };
      }
      col += colspan;
    });
    output.push(values);
    for (const span of pending) if (span?.remaining > 0) span.remaining -= 1;
  });
  return output;
}

function findDistanceTable($) {
  return $("table.wikitable").toArray().find((table) => {
    const text = $(table).find("tr").first().text();
    return /站间距|站距/.test(text) && text.includes("行政区");
  });
}

function parseDistance(value) {
  const normalized = value.replace(/,/g, "");
  const match = normalized.match(/^\d+/);
  return match ? Number(match[0]) : null;
}

function parseDistanceVariants(value) {
  const values = value.replace(/,/g, "").split("/").map((item) => Number(item.match(/^\d+/)?.[0])).filter(Number.isFinite);
  return values.length > 1 ? values : null;
}

function stationName(value) {
  return value.replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, "").replace(/\s*\([^)]*\)\s*$/g, "").trim();
}

function parseChineseDate(value) {
  const match = value.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : null;
}

export async function extractLine(file, lineId) {
  const html = await fs.readFile(file, "utf8");
  const $ = load(html);
  const table = findDistanceTable($);
  if (!table) throw new Error(`${file}: 未找到站间距表`);
  const rows = expandRows($, table);
  const header = rows[0];
  const nameIndex = header.findIndex((value) => value?.text.includes("站名"));
  const mileageIndex = header.findIndex((value) => /里程|距离|距離/.test(value?.text || "") && !value.text.includes("站间"));
  const distanceIndex = header.findIndex((value) => /站间距|站距/.test(value?.text || ""));
  const districtIndex = header.findIndex((value) => value?.text.includes("行政区"));
  const openedIndex = header.findIndex((value) => /开通日期|开通时间/.test(value?.text || ""));
  if ([nameIndex, distanceIndex, districtIndex].some((value) => value < 0)) {
    throw new Error(`${file}: 表头不完整：${header.map((cell) => cell.text).join(" | ")}`);
  }

  return rows.slice(1).map((row) => {
    const nameCell = row[nameIndex] || { text: "", links: [] };
    const nameZh = stationName(nameCell.text);
    const stationLink = nameCell.links.find((link) => stationName(link.text) === nameZh)
      || nameCell.links.find((link) => link.title?.includes("站"));
    const distanceText = row[distanceIndex]?.text || "";
    return {
      lineId,
      nameZh,
      wikipediaPageTitle: stationLink?.title || null,
      wikipediaPageUrl: stationLink ? new URL(stationLink.href, "https://zh.wikipedia.org").href : null,
      cumulativeM: mileageIndex >= 0 ? parseDistance(row[mileageIndex]?.text || "") : null,
      distanceFromPreviousM: parseDistance(distanceText),
      ...(parseDistanceVariants(distanceText) ? { directionalDistancesM: parseDistanceVariants(distanceText) } : {}),
      districtNameZh: row[districtIndex]?.text || "",
      openedAtText: openedIndex >= 0 ? row[openedIndex]?.text || "" : "",
      openedAt: openedIndex >= 0 ? parseChineseDate(row[openedIndex]?.text || "") : null
    };
  }).filter((row) => row.nameZh && row.distanceFromPreviousM !== null);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const inputs = [
    ["data/raw/wikipedia/line-6.html", "line-6"],
    ["data/raw/wikipedia/line-2.html", "line-2"],
    ["data/raw/wikipedia/line-1.html", "line-1"],
    ["data/raw/wikipedia/batong.html", "line-batong"]
  ];
  const result = {};
  for (const [file, lineId] of inputs) result[lineId] = await extractLine(file, lineId);
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0) {
    const outputPath = process.argv[outputIndex + 1];
    if (!outputPath) throw new Error("--output 缺少文件路径");
    await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`已写入 ${outputPath}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}
