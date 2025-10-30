#!/usr/bin/env node
import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import fs from "fs-extra";
import { Command } from "commander";
import axiosRetry from "axios-retry";
import { HttpsProxyAgent } from "https-proxy-agent";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import pLimit from "p-limit";

dotenv.config();

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;

const headers = {
  "User-Agent": "ResearchBot/1.0 (ResearchBot334@gmail.com)",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => axiosRetry.isNetworkOrIdempotentRequestError(error),
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();

function parseUrl(secUrl) {
  const urlObj = new URL(secUrl);
  const parts = urlObj.pathname.split("/").filter(Boolean);
  const cik = parts[3] || "unknownCIK";
  const accessionRaw = parts[4] || `accession-${Date.now()}`;
  const accessionNorm = accessionRaw.length === 18
    ? `${accessionRaw.slice(0,10)}-${accessionRaw.slice(10,12)}-${accessionRaw.slice(12)}`
    : accessionRaw;
  const docId = `${cik}-${accessionRaw}`;
  return { cik, accessionRaw, accessionNorm, docId };
}

async function setupDirectories(baseDir) {
  const exhibitsDir = path.join(baseDir, "exhibits");
  await fs.ensureDir(baseDir);
  await fs.ensureDir(exhibitsDir);
  return exhibitsDir;
}

function createAgent(proxy) {
  if (!SCRAPER_API_KEY && proxy) {
    console.log(`Using manual proxy: ${proxy}`);
    return new HttpsProxyAgent(proxy);
  }
  return null;
}

async function safeDownload(url, dest, agent) {
  await fs.ensureDir(path.dirname(dest));
  if (await fs.pathExists(dest)) {
    console.log(`Cached: ${dest}`);
    return await fs.readFile(dest);
  }
  console.log(`⬇️  Fetching: ${url}`);
  const fetchUrl = SCRAPER_API_KEY
    ? `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}`
    : url;

  const response = await axios.get(fetchUrl, {
    headers,
    httpsAgent: agent,
    timeout: 30000,
    responseType: "arraybuffer",
    maxContentLength: 50 * 1024 * 1024,
  });

  const buf = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
  await fs.writeFile(dest, buf);
  return buf;
}

function extractFilingInfo(html) {
  const $ = cheerio.load(html);
  let filingType = $("ix\\:nonnumeric[name='dei:DocumentType']").text().trim();
  if (!filingType) {
    filingType = $("meta[name='DOCUMENT_TYPE']").attr("content") || $("span.formHeader").text().trim() || "8-K";
  }
  let filedDate = $("ix\\:nonnumeric[name='dei:DocumentPeriodEndDate']").text().trim();
  if (!filedDate) {
    const filedMatch = html.match(/Filed\s*[:\s]\s*([A-Za-z0-9,\-\s]+)/i);
    if (filedMatch) filedDate = filedMatch[1].trim();
  }
  const isoDateMatch = filedDate?.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoDateMatch) filedDate = isoDateMatch[1];
  return { filingType, filedDate };
}

function extractExhibitUrls(html, baseUrl) {
  const $ = cheerio.load(html);
  const exhibitUrls = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const lower = href.toLowerCase();
    if (lower.includes("exhibit") || /ex-?\d+/i.test(href) || lower.endsWith(".pdf") || lower.endsWith(".htm") || lower.endsWith(".html")) {
      try {
        exhibitUrls.add(new URL(href, baseUrl).href);
      } catch {}
    }
  });
  return exhibitUrls;
}

function sanitizeFilename(raw) {
  let name = raw.split("?")[0].split("#")[0];
  name = decodeURIComponent(name);
  name = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!name) name = `exhibit_${Math.random().toString(36).slice(2,8)}`;
  return name;
}

function hashFile(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return {
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    md5: crypto.createHash("md5").update(buf).digest("hex"),
  };
}

async function downloadExhibits(exhibitUrls, exhibitsDir, concurrency, agent) {
  const files = [];
  const limit = pLimit(concurrency || 4);
  const exEntries = Array.from(exhibitUrls);

  const downloadTasks = exEntries.map((exUrl, idx) => limit(async () => {
    const rawName = exUrl.split("/").pop() || `exhibit-${idx+1}`;
    const fname = sanitizeFilename(rawName);
    let destName = fname;
    let counter = 1;
    while (await fs.pathExists(path.join(exhibitsDir, destName))) {
      destName = `${path.parse(fname).name}_${counter}${path.parse(fname).ext}`;
      counter++;
    }
    const dest = path.join(exhibitsDir, destName);
    try {
      const data = await safeDownload(exUrl, dest, agent);
      const hashes = hashFile(data);
      files.push({
        filename: path.join("exhibits", destName),
        url: exUrl,
        path: dest,
        ...hashes,
        role: "exhibit",
      });
    } catch (err) {
      console.warn(`Failed to download exhibit ${exUrl}: ${err.message}`);
      files.push({
        filename: path.join("exhibits", destName),
        url: exUrl,
        path: null,
        sha256: null,
        md5: null,
        role: "exhibit",
        error: err.message,
      });
    }
  }));

  await Promise.all(downloadTasks);
  return files;
}



// --- CLI Action ---
program
  .argument("<sec_url>", "URL of the SEC 8-K filing")
  .option("--out <dir>", "Output directory", "data/")
  .option("--proxy <url>", "Optional HTTPS proxy (ignored if using ScraperAPI)")
  .option("--concurrency <n>", "Max concurrent downloads", parseInt, 4)
  .action(async (secUrl, options) => {
    const outDir = options.out.replace(/\/$/, "");
    const { cik, accessionRaw, accessionNorm, docId } = parseUrl(secUrl);
    const baseDir = path.join(outDir, "raw", docId);
    const exhibitsDir = await setupDirectories(baseDir);
    const agent = createAgent(options.proxy);

    console.log(`Downloading primary filing...`);
    const mainPath = path.join(baseDir, "primary.html");
    const htmlBuffer = await safeDownload(secUrl, mainPath, agent);
    const html = htmlBuffer.toString("utf8");

    const { filingType, filedDate } = extractFilingInfo(html);

    const exhibitUrls = extractExhibitUrls(html, secUrl);
    console.log(`Found ${exhibitUrls.size} candidate exhibit URLs.`);

    const exhibitFiles = await downloadExhibits(exhibitUrls, exhibitsDir, options.concurrency, agent);

    const files = [
      {
        filename: path.basename(mainPath),
        url: secUrl,
        path: mainPath,
        ...hashFile(htmlBuffer),
        role: "primary",
      },
      ...exhibitFiles,
    ];

    const manifest = {
      doc_id: docId,
      primary_url: secUrl,
      filing_type: filingType,
      filed_date: filedDate || null,
      accession_raw: accessionRaw,
      accession_guess: accessionNorm,
      files: files.map(f => ({
        filename: f.filename,
        url: f.url,
        sha256: f.sha256,
        md5: f.md5,
        role: f.role,
        error: f.error || null
      })),
      scraper_api_used: !!SCRAPER_API_KEY,
      proxy_used: SCRAPER_API_KEY ? "ScraperAPI" : options.proxy || null,
      timestamp: new Date().toISOString(),
    };

    await fs.writeJson(path.join(baseDir, "manifest.json"), manifest, { spaces: 2 });
    console.log(`Done. Manifest written to ${path.join(baseDir, "manifest.json")}`);
  });

program.parse();
