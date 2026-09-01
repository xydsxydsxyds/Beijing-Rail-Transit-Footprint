import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const output = path.resolve(process.argv[2] || "data/raw/bjsubway-map-20260630.svg");
const browserCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

async function firstExisting(paths) {
  for (const candidate of paths) try { await fs.access(candidate); return candidate; } catch {}
  throw new Error("未找到 Chrome 或 Edge；可通过 CHROME_PATH 指定 Chromium 浏览器路径。");
}

async function waitForFile(file, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { return await fs.readFile(file, "utf8"); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error(`等待浏览器调试端口超时：${file}`);
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener("open", () => resolve({
      call(method, params = {}) {
        return new Promise((callResolve, callReject) => {
          const id = nextId++;
          pending.set(id, { resolve: callResolve, reject: callReject });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      close: () => socket.close()
    }));
    socket.addEventListener("message", async (event) => {
      const raw = typeof event.data === "string" ? event.data : await event.data.text();
      const message = JSON.parse(raw);
      if (!message.id || !pending.has(message.id)) return;
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
    });
    socket.addEventListener("error", reject);
  });
}

const browserPath = await firstExisting(browserCandidates);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "bjsubway-svg-"));
const processHandle = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "https://map.bjsubway.com/"
], { stdio: "ignore", windowsHide: true });

try {
  const activePort = await waitForFile(path.join(profile, "DevToolsActivePort"));
  const port = activePort.split(/\r?\n/)[0];
  let target;
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && item.url.startsWith("https://map.bjsubway.com"));
    if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!target) throw new Error("没有找到北京地铁地图页面的调试目标。");
  const expression = `(async()=>{for(let i=0;i<200;i++){const s=document.querySelector('svg#subwaymap_svg');if(s&&s.querySelectorAll('[sdata]').length>500)return s.outerHTML;await new Promise(r=>setTimeout(r,100));}throw new Error('官方 SVG 未在规定时间内生成');})()`;
  let result;
  for (let attempt = 0; attempt < 8 && !result; attempt++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && item.url.startsWith("https://map.bjsubway.com")) || target;
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    try { result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); }
    catch (error) { if (!/context was destroyed/i.test(error.message) || attempt === 7) throw error; await new Promise((resolve) => setTimeout(resolve, 500)); }
    finally { cdp.close(); }
  }
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "页面执行失败");
  const svg = result.result?.value;
  if (typeof svg !== "string" || !svg.includes("sdata=")) throw new Error("未取得有效的官方 SVG。");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${svg}\n`, "utf8");
  console.log(`官方 SVG 已保存：${output}（${svg.length} 字符）`);
} finally {
  processHandle.kill();
  if (processHandle.exitCode === null) await Promise.race([once(processHandle, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); break; }
    catch (error) { if (attempt === 4) console.warn(`临时浏览器目录稍后由系统清理：${error.message}`); await new Promise((resolve) => setTimeout(resolve, 300)); }
  }
}
