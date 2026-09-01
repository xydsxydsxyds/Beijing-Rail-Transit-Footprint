import fs from "node:fs/promises";
import path from "node:path";

const manifestPath = process.argv.slice(2).find((value) => !value.startsWith("--")) || "data/sources/line-manifest.json";
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const currentPageMode = process.argv.includes("--current");
const outputDirectory = "data/raw/wikipedia/lines";
const revisionReport = {
  effectiveDate: manifest.effectiveDate,
  retrievedAt: new Date().toISOString(),
  snapshotMode: currentPageMode ? "current-page" : "historical-revision",
  pages: {}
};
const userAgent = "BeijingRailFootprint/0.1 (line data preparation)";

async function fetchWithRetry(url, label, asJson = false) {
  let delay = 1500;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": userAgent, Accept: asJson ? "application/json" : "text/html" } });
      if (response.ok) return asJson ? response.json() : response.text();
      if (![429, 502, 503, 504].includes(response.status) || attempt === 5) throw new Error(`${label}: HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 5 || (error.message?.startsWith(label) && error.message.includes("HTTP 4") && !error.message.includes("429"))) throw error;
      console.warn(`${label}: 网络异常，${delay}ms 后重试 ${attempt}/5`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 12000);
  }
}

await fs.mkdir(outputDirectory, { recursive: true });
for (const line of currentPageMode ? [] : manifest.lines) {
  const params = new URLSearchParams({
    action: "query", format: "json", formatversion: "2", prop: "revisions", redirects: "1",
    rvprop: "ids|timestamp", rvlimit: "1", rvstart: `${manifest.effectiveDate}T23:59:59Z`, rvdir: "older",
    titles: line.wikipediaPageTitle
  });
  const body = await fetchWithRetry(`https://zh.wikipedia.org/w/api.php?${params}`, "查询历史修订", true);
  if (body.error) throw new Error(`${line.id}: MediaWiki API ${body.error.code}: ${body.error.info}`);
  const redirects = new Map((body.query?.redirects || []).map((item) => [item.from, item.to]));
  const pages = new Map((body.query?.pages || []).map((page) => [page.title, page]));
  const resolvedTitle = redirects.get(line.wikipediaPageTitle) || line.wikipediaPageTitle;
  const page = pages.get(resolvedTitle);
  const revision = page?.revisions?.[0];
  if (!revision) throw new Error(`${line.id}: 未找到 ${manifest.effectiveDate} 或更早的页面修订`);
  revisionReport.pages[line.id] = {
    requestedTitle: line.wikipediaPageTitle,
    resolvedTitle,
    pageId: page.pageid,
    revisionId: revision.revid,
    revisionTimestamp: revision.timestamp,
    snapshotFile: line.snapshotFile
  };
}

if (currentPageMode) {
  for (const line of manifest.lines) {
    revisionReport.pages[line.id] = {
      requestedTitle: line.wikipediaPageTitle,
      resolvedTitle: line.wikipediaPageTitle,
      revisionId: null,
      revisionTimestamp: null,
      snapshotFile: line.snapshotFile,
      note: "当前页面快照；生成业务数据时必须按 manifest effectiveDate 过滤开通日期"
    };
  }
}

let completed = 0;
for (const line of manifest.lines) {
  const revision = revisionReport.pages[line.id];
  const url = currentPageMode
    ? `https://zh.wikipedia.org/wiki/${encodeURIComponent(line.wikipediaPageTitle)}`
    : `https://zh.wikipedia.org/w/index.php?oldid=${revision.revisionId}`;
  const html = await fetchWithRetry(url, `下载 ${line.nameZh}`);
  await fs.writeFile(path.join(outputDirectory, line.snapshotFile), html, "utf8");
  completed += 1;
  console.log(`[${completed}/${manifest.lines.length}] ${line.nameZh} @ ${revision.revisionTimestamp || "current-page"}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
}
await fs.writeFile(path.join(outputDirectory, "revision-index.json"), `${JSON.stringify(revisionReport, null, 2)}\n`, "utf8");
console.log(`已保存 ${completed} 个${currentPageMode ? "当前页面" : "历史修订"}快照。`);
