#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { validateData } from "./validation.mjs";

function usage() {
  return [
    "用法：",
    "  node scripts/validate-data.mjs --network <network.json> [--footprint <footprint.json>] [--json]",
    "",
    "退出码：0=通过（可含警告），1=校验错误，2=命令或文件错误"
  ].join("\n");
}

function parseArgs(argv) {
  const result = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") result.json = true;
    else if (arg === "--network" || arg === "--footprint") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少文件路径`);
      result[arg.slice(2)] = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return result;
}

async function readJson(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return JSON.parse(await fs.readFile(resolved, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 JSON 文件 ${resolved}：${error.message}`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!options.network) throw new Error("必须提供 --network");
  const network = await readJson(options.network);
  const footprint = options.footprint ? await readJson(options.footprint) : undefined;
  const issues = await validateData(network, footprint);
  const errors = issues.filter((item) => item.level === "error");
  const warnings = issues.filter((item) => item.level === "warning");

  if (options.json) {
    console.log(JSON.stringify({ valid: errors.length === 0, errors: errors.length, warnings: warnings.length, issues }, null, 2));
  } else if (!issues.length) {
    console.log("校验通过：未发现错误或警告。");
  } else {
    for (const item of issues) console.log(`${item.level === "error" ? "错误" : "警告"} [${item.code}] ${item.location}: ${item.message}`);
    console.log(`校验完成：${errors.length} 个错误，${warnings.length} 个警告。`);
  }
  process.exitCode = errors.length ? 1 : 0;
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exitCode = 2;
}
