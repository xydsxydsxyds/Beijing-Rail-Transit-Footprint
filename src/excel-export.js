import { calculateStatistics } from "./statistics.js";
import { isolatedVisits, missingContinuousEndpoints } from "./footprint-io.js";

const encoder = new TextEncoder();
const xmlEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
const cell = (value, style = 0) => ({ value, style });
const percentCell = (value) => cell(value, 3);
const integerCell = (value) => cell(value, 5);
const decimalCell = (value) => cell(value, 4);
const columnName = (index) => { let result = ""; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result; };

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) { return Uint8Array.of(value & 255, (value >>> 8) & 255); }
function u32(value) { return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255); }
function concat(parts) { const length = parts.reduce((sum, part) => sum + part.length, 0), output = new Uint8Array(length); let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output; }

function zipStore(files) {
  const local = [], central = []; let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name), data = typeof content === "string" ? encoder.encode(content) : content, crc = crc32(data);
    const header = concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes]);
    local.push(header, data);
    central.push(concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes]));
    offset += header.length + data.length;
  }
  const centralBytes = concat(central), end = concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralBytes.length), u32(offset), u16(0)]);
  return concat([...local, centralBytes, end]);
}

function worksheetXml(sheet) {
  const rows = sheet.rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((entry, columnIndex) => {
    const item = entry && typeof entry === "object" && "value" in entry ? entry : cell(entry);
    const ref = `${columnName(columnIndex)}${rowIndex + 1}`, style = item.style ? ` s="${item.style}"` : "";
    if (typeof item.value === "number" && Number.isFinite(item.value)) return `<c r="${ref}"${style}><v>${item.value}</v></c>`;
    if (typeof item.value === "boolean") return `<c r="${ref}" t="b"${style}><v>${item.value ? 1 : 0}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(item.value)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const maxCols = Math.max(1, ...sheet.rows.map((row) => row.length)), end = `${columnName(maxCols - 1)}${Math.max(1, sheet.rows.length)}`;
  const columns = (sheet.widths || []).map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const filter = sheet.filter && sheet.rows.length > 1 ? `<autoFilter ref="A${sheet.filter}:${end}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freeze || 0}" topLeftCell="A${(sheet.freeze || 0) + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData>${rows}</sheetData>${filter}</worksheet>`;
}

function sheet(title, headers, rows, widths) {
  return { name: title, rows: [[cell(title, 1)], headers.map((value) => cell(value, 2)), ...rows], widths, freeze: 2, filter: 2 };
}

function visitTypeLabel(types) {
  const labels = { board_or_alight: "上下车", in_station_transfer: "站内换乘", out_of_station_transfer: "出站换乘" };
  return types.map((type) => labels[type] || type).join("、");
}

export function buildExcelSheets(network, file) {
  const stats = calculateStatistics(network, file), stationById = new Map(network.stations.map((item) => [item.id, item])), lineStationById = new Map(network.lineStations.map((item) => [item.id, item])), lineById = new Map(network.lines.map((item) => [item.id, item]));
  const overview = [
    ["足迹名称", file.title, ""], ["生成时间", new Date().toISOString(), ""], ["数据集版本", network.meta.datasetVersion, ""], ["数据截止日期", network.meta.effectiveDate, ""],
    ["精确乘坐里程（km）", decimalCell(stats.mileageM / 1000), percentCell(stats.totalMileageM ? stats.mileageM / stats.totalMileageM : 0)],
    ["到访车站", integerCell(stats.visited.length), percentCell(network.stations.length ? stats.visited.length / network.stations.length : 0)],
    ["已乘区间", integerCell(stats.riddenIds.length), percentCell(network.segments.length ? stats.riddenIds.length / network.segments.length : 0)],
    ["参与线路", integerCell(stats.participatedLines.length), percentCell(network.lines.length ? stats.participatedLines.length / network.lines.length : 0)],
    ["完成线路", integerCell(stats.completedLines.length), percentCell(network.lines.length ? stats.completedLines.length / network.lines.length : 0)],
    ["到访行政区", integerCell(stats.visitedDistrictIds.size), percentCell(network.districts.length ? stats.visitedDistrictIds.size / network.districts.length : 0)],
    ["到访换乘站", integerCell(stats.visitedTransfers), percentCell(stats.transferStationIds.size ? stats.visitedTransfers / stats.transferStationIds.size : 0)],
    ["总积分", integerCell(stats.points.total), ""]
  ];
  const scoreRows = [["里程积分", stats.points.mileage, "总里程按公里四舍五入"], ["车站积分", stats.points.stations, "每座到访物理站 1 分"], ["换乘站加分", stats.points.transfers, "每座到访换乘站额外 1 分"], ["行政区积分", stats.points.districts, "每个到访行政区 4 分"], ["完成线路积分", stats.points.lines, "每条完成线路 10 分"]];
  const lines = stats.lines.map((item) => [item.line.nameZh, item.stationCount, item.stationTotal, percentCell(item.stationRate), item.segmentCount, item.segmentTotal, percentCell(item.segmentRate), item.complete ? "是" : "否"]);
  const districts = stats.districts.map((item) => [item.district.nameZh, item.count, item.total, percentCell(item.rate)]);
  const visits = file.stationVisits.map((visit) => { const station = stationById.get(visit.stationId); return [station?.nameZh || visit.stationId, visitTypeLabel(visit.visitTypes), (station?.districtIds || []).map((id) => network.districts.find((item) => item.id === id)?.nameZh || id).join("、")]; });
  const segments = file.selectedSegmentIds.map((id) => { const segment = network.segments.find((item) => item.id === id); if (!segment) return [id, "", "", "", ""]; const from = stationById.get(lineStationById.get(segment.fromLineStationId)?.stationId), to = stationById.get(lineStationById.get(segment.toLineStationId)?.stationId); return [lineById.get(segment.lineId)?.nameZh || segment.lineId, from?.nameZh || "", to?.nameZh || "", segment.distanceM, id]; });
  const validation = [...missingContinuousEndpoints(file, network).map((item) => ["连续区间到访", item.groupName, item.kind === "closed_loop_without_visit" ? "闭合区间内未选择任何到访车站" : `端点站 ${item.stationName} 未选中`]), ...isolatedVisits(file, network).map((name) => ["孤立到访车站", name, "不邻接任何已乘区间"])];
  return [
    sheet("概览与积分", ["指标", "数值", "覆盖率/说明"], [...overview, [], [cell("积分明细", 1)], ...scoreRows], [24, 22, 36]),
    sheet("线路统计", ["线路", "到访车站", "车站总数", "车站比例", "已乘区间", "区间总数", "区间比例", "完成"], lines, [18, 12, 12, 12, 12, 12, 12, 10]),
    sheet("行政区统计", ["行政区", "到访车站", "车站总数", "到访比例"], districts, [18, 14, 14, 14]),
    sheet("到访车站", ["车站", "到访类型", "行政区"], visits, [22, 20, 28]),
    sheet("已乘区间", ["线路", "起点", "终点", "距离（米）", "区间 ID"], segments, [18, 22, 22, 14, 46]),
    sheet("校验提示", ["类型", "线路/车站", "说明"], validation.length ? validation : [["无", "", "导出校验未发现提示项"]], [22, 24, 48])
  ];
}

export function buildXlsxBytes(network, file) {
  const sheets = buildExcelSheets(network, file), workbookSheets = sheets.map((item, index) => `<sheet name="${xmlEscape(item.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join(""), relationships = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  const files = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF164F7A"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF33735B"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFD7DCD7"/></left><right style="thin"><color rgb="FFD7DCD7"/></right><top style="thin"><color rgb="FFD7DCD7"/></top><bottom style="thin"><color rgb="FFD7DCD7"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...sheets.map((item, index) => [`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(item)])
  ];
  return zipStore(files);
}

export function buildXlsxBlob(network, file) { return new Blob([buildXlsxBytes(network, file)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); }
