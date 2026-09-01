import fs from "node:fs/promises";
import { extractLine } from "./extract-wikipedia-lines.mjs";

const inputs = [
  ["data/raw/wikipedia/line-6.html", "line-6"],
  ["data/raw/wikipedia/line-2.html", "line-2"],
  ["data/raw/wikipedia/line-1.html", "line-1"],
  ["data/raw/wikipedia/batong.html", "line-batong"]
];
const userAgent = "BeijingRailFootprintSample/0.1 (data preparation)";

async function fetchJson(url, label) {
  let delayMs = 2000;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "application/json" } });
    if (response.ok) return response.json();
    if (![429, 502, 503, 504].includes(response.status) || attempt === 5) {
      throw new Error(`${label} 返回 ${response.status}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : delayMs;
    console.warn(`${label} 暂时不可用（${response.status}），${waitMs}ms 后重试 ${attempt}/5`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    delayMs = Math.min(delayMs * 2, 16000);
  }
  throw new Error(`${label} 查询失败`);
}

function aliasResolver(query) {
  const aliases = new Map();
  for (const item of query?.normalized || []) aliases.set(item.from, item.to);
  for (const item of query?.redirects || []) aliases.set(item.from, item.to);
  return (title) => {
    let current = title;
    const seen = new Set();
    while (aliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = aliases.get(current);
    }
    return current;
  };
}

const entriesByName = new Map();
for (const [file, lineId] of inputs) {
  for (const row of await extractLine(file, lineId)) {
    if (!row.wikipediaPageTitle || !row.wikipediaPageUrl) {
      throw new Error(`${lineId} ${row.nameZh}: 线路表格中缺少准确词条链接`);
    }
    const existing = entriesByName.get(row.nameZh);
    if (existing && existing.requestedTitle !== row.wikipediaPageTitle) {
      throw new Error(`${row.nameZh}: 不同线路链接标题冲突：${existing.requestedTitle} / ${row.wikipediaPageTitle}`);
    }
    entriesByName.set(row.nameZh, {
      nameZh: row.nameZh,
      requestedTitle: row.wikipediaPageTitle,
      pageUrl: row.wikipediaPageUrl
    });
  }
}

const entries = [...entriesByName.values()];
const result = {
  retrievedAt: new Date().toISOString(),
  wikipediaApi: "https://zh.wikipedia.org/w/api.php",
  wikidataApi: "https://www.wikidata.org/w/api.php",
  stations: {}
};
const itemToNames = new Map();

for (let index = 0; index < entries.length; index += 40) {
  const batch = entries.slice(index, index + 40);
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "coordinates|pageprops",
    redirects: "1",
    colimit: "max",
    titles: batch.map((item) => item.requestedTitle).join("|")
  });
  const body = await fetchJson(`https://zh.wikipedia.org/w/api.php?${params}`, "Wikipedia API");
  const resolve = aliasResolver(body.query);
  const pages = new Map((body.query?.pages || []).map((page) => [page.title, page]));
  for (const entry of batch) {
    const resolvedTitle = resolve(entry.requestedTitle);
    const page = pages.get(resolvedTitle);
    const direct = page?.coordinates?.[0];
    const wikidataItem = page?.pageprops?.wikibase_item;
    result.stations[entry.nameZh] = {
      requestedTitle: entry.requestedTitle,
      pageUrl: entry.pageUrl,
      resolvedTitle,
      ...(page?.pageid ? { pageId: page.pageid } : {}),
      ...(wikidataItem ? { wikidataItem } : {}),
      ...(direct
        ? { lat: direct.lat, lng: direct.lon, coordinateSource: "wikipedia-page" }
        : { missing: true })
    };
    if (!direct && wikidataItem) {
      if (!itemToNames.has(wikidataItem)) itemToNames.set(wikidataItem, []);
      itemToNames.get(wikidataItem).push(entry.nameZh);
    }
  }
}

const itemIds = [...itemToNames.keys()];
for (let index = 0; index < itemIds.length; index += 50) {
  const batch = itemIds.slice(index, index + 50);
  const params = new URLSearchParams({
    action: "wbgetentities",
    format: "json",
    props: "claims",
    ids: batch.join("|")
  });
  const body = await fetchJson(`https://www.wikidata.org/w/api.php?${params}`, "Wikidata API");
  for (const itemId of batch) {
    const value = body.entities?.[itemId]?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
    if (!value || typeof value.latitude !== "number" || typeof value.longitude !== "number") continue;
    for (const nameZh of itemToNames.get(itemId)) {
      Object.assign(result.stations[nameZh], {
        lat: value.latitude,
        lng: value.longitude,
        coordinateSource: "wikidata-p625"
      });
      delete result.stations[nameZh].missing;
    }
  }
}

await fs.writeFile("data/raw/wikipedia/station-coordinates.json", `${JSON.stringify(result, null, 2)}\n`, "utf8");
const missing = Object.entries(result.stations).filter(([, value]) => value.missing).map(([name]) => name);
const directCount = Object.values(result.stations).filter((value) => value.coordinateSource === "wikipedia-page").length;
const wikidataCount = Object.values(result.stations).filter((value) => value.coordinateSource === "wikidata-p625").length;
console.log(`查询完成：${entries.length} 个车站；页面坐标 ${directCount} 个，Wikidata P625 ${wikidataCount} 个，缺失 ${missing.length} 个。`);
if (missing.length) console.log(`仍缺少：${missing.join("、")}`);
