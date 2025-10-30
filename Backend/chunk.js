#!/usr/bin/env node
import fs from "fs-extra";
import path from "path";
import { Command } from "commander";
import * as cheerio from "cheerio";
import { createWorker } from "tesseract.js";
import sharp from "sharp";
import { fromPath } from "pdf2pic";

const program = new Command();

program
  .argument("<doc_id>", "Document ID (e.g. 1178670)")
  .option("--target <num>", "Target chunk size", "3000")
  .option("--overlap <num>", "Chunk overlap", "200")
  .option("--ocr", "Enable OCR for image-based exhibits", false)
  .option("--ocr-lang <lang>", "OCR language", "eng")
  .parse(process.argv);

const [docId] = program.args;
const opts = program.opts();
const targetSize = parseInt(opts.target);
const overlap = parseInt(opts.overlap);
const enableOcr = opts.ocr;
const ocrLang = opts.ocrLang;

const RAW_DIR = path.join("data", "raw", docId);
const CHUNK_DIR = path.join("data", "chunks", docId);
const OCR_CACHE_DIR = path.join("data", "ocr_cache", docId);

// OCR worker pool for better performance
let ocrWorker = null;

async function initOcrWorker() {
  if (!enableOcr || ocrWorker) return;
  console.log("Initializing OCR worker...");
  ocrWorker = await createWorker(ocrLang);
  await ocrWorker.setParameters({
    tessedit_pageseg_mode: "1", // Auto page segmentation with OSD
    preserve_interword_spaces: "1",
  });
}

async function cleanupOcrWorker() {
  if (ocrWorker) {
    await ocrWorker.terminate();
    ocrWorker = null;
  }
}

async function loadManifest(docId) {
  const manifestPath = path.join(RAW_DIR, "manifest.json");
  if (!(await fs.pathExists(manifestPath))) {
    throw new Error(`Manifest not found at ${manifestPath}`);
  }
  return fs.readJson(manifestPath);
}

async function readHtmlFiles(manifest) {
  const files = [];
  for (const file of manifest.files) {
    const filePath = path.join(RAW_DIR, file.filename);
    if (!(await fs.pathExists(filePath))) {
      console.warn(`Missing file: ${filePath}`);
      continue;
    }
    
    const ext = path.extname(file.filename).toLowerCase();
    
    // Determine file type and process accordingly
    if (ext === ".pdf" && enableOcr) {
      const text = await processPdfWithOcr(filePath, file.filename);
      files.push({ filename: file.filename, text, isOcr: true });
    } else if ([".jpg", ".jpeg", ".png", ".tiff", ".bmp"].includes(ext) && enableOcr) {
      const text = await processImageWithOcr(filePath, file.filename);
      files.push({ filename: file.filename, text, isOcr: true });
    } else if (ext === ".htm" || ext === ".html") {
      const html = await fs.readFile(filePath, "utf-8");
      files.push({ filename: file.filename, html, isOcr: false });
    } else {
      // Try to read as text
      try {
        const content = await fs.readFile(filePath, "utf-8");
        files.push({ filename: file.filename, text: content, isOcr: false });
      } catch (err) {
        console.warn(`Skipping binary file: ${file.filename}`);
      }
    }
  }
  return files;
}

async function processImageWithOcr(imagePath, filename) {
  const cacheKey = path.basename(filename, path.extname(filename));
  const cachePath = path.join(OCR_CACHE_DIR, `${cacheKey}.txt`);
  
  // Check cache first
  if (await fs.pathExists(cachePath)) {
    console.log(`Using cached OCR for ${filename}`);
    return fs.readFile(cachePath, "utf-8");
  }
  
  console.log(`Running OCR on image: ${filename}`);
  
  // Preprocess image for better OCR results
  const processedPath = path.join(OCR_CACHE_DIR, `${cacheKey}_processed.png`);
  await fs.ensureDir(OCR_CACHE_DIR);
  
  await sharp(imagePath)
    .greyscale()
    .normalise()
    .sharpen()
    .png()
    .toFile(processedPath);
  
  // Run OCR
  const { data: { text } } = await ocrWorker.recognize(processedPath);
  
  // Cache the result
  await fs.writeFile(cachePath, text, "utf-8");
  
  // Clean up processed image
  await fs.remove(processedPath);
  
  return text;
}

async function processPdfWithOcr(pdfPath, filename) {
  const cacheKey = path.basename(filename, ".pdf");
  const cachePath = path.join(OCR_CACHE_DIR, `${cacheKey}.txt`);
  
  // Check cache
  if (await fs.pathExists(cachePath)) {
    console.log(`Using cached OCR for ${filename}`);
    return fs.readFile(cachePath, "utf-8");
  }
  
  console.log(`Running OCR on PDF: ${filename}`);
  await fs.ensureDir(OCR_CACHE_DIR);
  
  const options = {
    density: 300,
    saveFilename: cacheKey,
    savePath: OCR_CACHE_DIR,
    format: "png",
    width: 2100,
    height: 2970,
  };
  
  const convert = fromPath(pdfPath, options);
  
  let allText = "";
  let pageNum = 1;
  
  try {
    // Convert PDF pages to images and OCR each
    while (true) {
      try {
        const page = await convert(pageNum, { responseType: "image" });
        console.log(`OCR PDF page ${pageNum}...`);
        
        const { data: { text } } = await ocrWorker.recognize(page.path);
        allText += `\n\n=== PAGE ${pageNum} ===\n\n${text}`;
        
        // Clean up page image
        await fs.remove(page.path);
        pageNum++;
      } catch (err) {
        // No more pages
        break;
      }
    }
  } catch (err) {
    console.error(`Error processing PDF ${filename}:`, err.message);
  }
  
  // Cache the result
  await fs.writeFile(cachePath, allText, "utf-8");
  
  return allText;
}

function cleanText(text) {
  return text.replace(/\r/g, "")
             .replace(/\u00a0/g, " ")
             .replace(/\s+/g, " ")
             .trim();
}

function processHtml(html, fileName) {
  const $ = cheerio.load(html, { decodeEntities: true, xmlMode: true });
  $("script, style, noscript").remove();

  $('ix\\:nonNumeric, [name^="dei:"]').each((_, el) => {
    const text = $(el).text().trim();
    if (text) $(el).replaceWith(` ${text} `);
  });

  const lines = [`=== SOURCE: ${fileName} ===\n`];
  const processed = new Set();

  function processElement(el) {
    if (processed.has(el)) return;
    processed.add(el);

    const tag = $(el).prop("tagName")?.toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      const text = cleanText($(el).text());
      if (text) lines.push(`\n# ${text}\n`);
      return;
    }

    const directText = $(el).contents().filter(function () { return this.type === 'text'; }).text();
    if (/^Item\s+\d+(\.\d+)?/i.test(cleanText(directText))) {
      lines.push(`\n=== ${cleanText(directText)} ===\n`);
      return;
    }

    if (tag === "table") {
      const tableText = $(el).text();
      if (/Exact\s+name\s+of\s+registrant|State.*?jurisdiction.*?incorporation|Commission.*?File.*?Number/i.test(tableText)) {
        $(el).find("tr").each((_, tr) => {
          const cells = [];
          $(tr).find("th,td").each((_, cell) => {
            const cellText = cleanText($(cell).text());
            if (cellText) cells.push(cellText);
          });
          if (cells.length > 0) lines.push(cells.join("\n"));
        });
        return;
      }

      $(el).find("tr").each((_, tr) => {
        const row = [];
        $(tr).find("th,td").each((_, cell) => row.push(cleanText($(cell).text())));
        if (row.some(c => c.length > 0)) lines.push(row.join("\t"));
      });
      return;
    }

    if (["p", "div", "li"].includes(tag)) {
      const text = cleanText($(el).clone().children().remove().end().text());
      if (text && text.length > 10) lines.push(text);
    }
  }

  $("body").find("*").each((_, el) => processElement(el));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function processPlainText(text, fileName) {
  return `=== SOURCE: ${fileName} ===\n\n${text}`;
}

function chunkText(text, target = 3000, overlap = 200) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + target, text.length);
    const slice = text.slice(start, end);
    chunks.push({ start, end, text: slice });
    if (end === text.length) break;
    start += target - overlap;
  }
  return chunks;
}

async function saveChunks(chunks, metadata = {}) {
  await fs.ensureDir(CHUNK_DIR);
  const index = { 
    totalLength: chunks.reduce((sum, c) => sum + c.text.length, 0), 
    chunks: [],
    metadata: {
      ocrEnabled: enableOcr,
      ocrLang: ocrLang,
      ...metadata
    }
  };

  for (let i = 0; i < chunks.length; i++) {
    const name = `chunk_${String(i + 1).padStart(4, "0")}.txt`;
    await fs.writeFile(path.join(CHUNK_DIR, name), chunks[i].text, "utf-8");
    index.chunks.push({ file: name, start: chunks[i].start, end: chunks[i].end });
  }

  await fs.writeJson(path.join(CHUNK_DIR, "index.json"), index, { spaces: 2 });
  return chunks.length;
}

// --- Main ---
async function main() {
  try {
    await initOcrWorker();
    
    const manifest = await loadManifest(docId);
    const processedFiles = await readHtmlFiles(manifest);

    let fullText = "";
    const fileStats = { html: 0, ocr: 0, text: 0 };
    
    for (const file of processedFiles) {
      if (file.html) {
        fullText += "\n\n" + processHtml(file.html, file.filename);
        fileStats.html++;
      } else if (file.text) {
        fullText += "\n\n" + processPlainText(file.text, file.filename);
        if (file.isOcr) {
          fileStats.ocr++;
        } else {
          fileStats.text++;
        }
      }
    }

    const chunks = chunkText(fullText, targetSize, overlap);
    const count = await saveChunks(chunks, { fileStats });
    
    console.log(`\nChunking complete for ${docId}:`);
    console.log(`  - ${count} chunks generated`);
    console.log(`  - ${fileStats.html} HTML files`);
    console.log(`  - ${fileStats.text} text files`);
    if (enableOcr) {
      console.log(`  - ${fileStats.ocr} files processed with OCR`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await cleanupOcrWorker();
  }
}

await main();