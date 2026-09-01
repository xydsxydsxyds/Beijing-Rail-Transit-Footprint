import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";

const inputPath = "data/intermediate/network-source.json";
const outputPath = "data/raw/wikipedia/network-station-coordinates.json";
const source = JSON.parse(await fs.readFile(inputPath, "utf8"));
const existing = await fs.readFile(outputPath, "utf8").then(JSON.parse).catch(() => ({ stations: {} }));
const sample = await fs.readFile("data/raw/wikipedia/station-coordinates.json", "utf8").then(JSON.parse).catch(() => ({ stations: {} }));
const stations = { ...sample.stations, ...existing.stations };
const entries = new Map();
for (const rows of Object.values(source.lines)) {
  for (const row of rows) {
    if (!entries.has(row.nameZh)) entries.set(row.nameZh, row.wikipediaPageTitle || `${row.nameZh}站`);
  }
}

const pending = [...entries].filter(([name]) => !stations[name] || stations[name].missing);
for (let offset = 0; offset < pending.length; offset += 40) {
  const batch = pending.slice(offset, offset + 40);
  const titles = batch.map(([, title]) => title);
  const url = new URL("https://zh.wikipedia.org/w/api.php");
  url.search = new URLSearchParams({ action: "query", format: "json", formatversion: "2", redirects: "1", prop: "coordinates", colimit: "max", titles: titles.join("|") });
  let response;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      response = await fetch(url, { headers: { "User-Agent": "BeijingRailTransitFootprint/0.1 (data research)" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  const json = await response.json();
  const pages = new Map(json.query.pages.map((page) => [page.title, page]));
  const redirects = new Map((json.query.redirects || []).map((item) => [item.from, item.to]));
  const normalized = new Map((json.query.normalized || []).map((item) => [item.from, item.to]));
  for (const [name, title] of batch) {
    const normalizedTitle = normalized.get(title) || title;
    const resolvedTitle = redirects.get(normalizedTitle) || normalizedTitle;
    const page = pages.get(resolvedTitle) || pages.get(normalizedTitle) || pages.get(title);
    const coordinate = page?.coordinates?.[0];
    stations[name] = coordinate
      ? { title: page.title, pageId: page.pageid, lat: coordinate.lat, lng: coordinate.lon, retrievedAt: new Date().toISOString().slice(0, 10) }
      : { title: page?.title || title, pageId: page?.pageid || null, missing: true, retrievedAt: new Date().toISOString().slice(0, 10) };
  }
  console.log(`坐标进度：${Math.min(offset + batch.length, pending.length)}/${pending.length}`);
}

function dmsToDecimal(text) {
  const match = text.replace(/\s+/g, "").match(/(\d+)[°º](\d+)[′']([\d.]+)[″"]?([NSEW北南东西])/i);
  if (!match) return null;
  const value = Number(match[1]) + Number(match[2]) / 60 + Number(match[3]) / 3600;
  return /[SW南西]/i.test(match[4]) ? -value : value;
}

// 部分车站只在信息框“地理坐标”中给出坐标，没有注册页面级 coordinates 属性。
for (const [name, title] of entries) {
  if (!stations[name]?.missing) continue;
  const url = new URL("https://zh.wikipedia.org/w/api.php");
  url.search = new URLSearchParams({ action: "parse", format: "json", formatversion: "2", redirects: "1", page: title, prop: "text" });
  let response;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    response = await fetch(url, { headers: { "User-Agent": "BeijingRailTransitFootprint/0.1 (data research)" } });
    if (response.ok) break;
    if (attempt === 5) throw new Error(`${name}: 信息框请求失败 HTTP ${response.status}`);
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfter * 1000, attempt * 2000)));
  }
  const json = await response.json();
  const $ = load(json.parse?.text || "");
  const header = $("th").filter((_, element) => $(element).text().replace(/\s+/g, "").includes("地理坐标")).first();
  const cell = header.next("td");
  const lat = dmsToDecimal(cell.find(".latitude").first().text());
  const lng = dmsToDecimal(cell.find(".longitude").first().text());
  if (lat !== null && lng !== null) {
    stations[name] = { title: json.parse.title, pageId: json.parse.pageid, lat, lng, coordinateSource: "infobox-geography", retrievedAt: new Date().toISOString().slice(0, 10) };
    console.log(`信息框坐标：${name}`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), stations }, null, 2)}\n`, "utf8");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const selected = {};
for (const name of [...entries.keys()].sort((a, b) => a.localeCompare(b, "zh-CN"))) selected[name] = stations[name];
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), stations: selected }, null, 2)}\n`, "utf8");
console.log(`已写入 ${outputPath}：${Object.keys(selected).length} 站，缺失 ${Object.values(selected).filter((x) => x.missing).length} 站。`);
