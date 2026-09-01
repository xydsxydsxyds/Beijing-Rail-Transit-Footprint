import fs from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";

for (const file of process.argv.slice(2).filter((argument) => !argument.startsWith("--"))) {
  const html = await fs.readFile(file, "utf8");
  const $ = load(html);
  console.log(`\n${path.basename(file)}`);
  $("table.wikitable").each((index, table) => {
    const headers = $(table).find("tr").first().find("th,td").map((_, cell) => $(cell).text().replace(/\s+/g, " ").trim()).get();
    if (process.argv.includes("--all") || headers.some((header) => header.includes("站间距"))) {
      console.log(`table ${index}: ${headers.join(" | ")}`);
      $(table).find("tr").slice(1, 5).each((_, row) => {
        const cells = $(row).find("th,td").map((__, cell) => $(cell).text().replace(/\s+/g, " ").trim()).get();
        console.log(`  ${cells.join(" | ")}`);
      });
    }
  });
}
