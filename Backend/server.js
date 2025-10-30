import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Helper to run CLI commands
function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [command, ...args], {
      cwd: __dirname,
      ...options
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      console.log(text);
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      console.error(text);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// Extract doc_id from SEC URL
function extractDocId(secUrl) {
  try {
    const url = new URL(secUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    const cik = parts[3] || 'unknownCIK';
    const accessionRaw = parts[4] || `accession-${Date.now()}`;
    return `${cik}-${accessionRaw}`;
  } catch (err) {
    throw new Error('Invalid SEC URL');
  }
}

// Parse console output for progress
function parseProgress(output) {
  const lines = output.split('\n');
  const logs = [];

  for (const line of lines) {
    if (line.trim()) {
      let type = 'info';
      if (line.includes('[SUCCESS]') || line.includes('[OK]')) type = 'success';
      else if (line.includes('[ERROR]') || line.includes('[WARN]')) type = 'error';

      logs.push({
        message: line,
        type,
        timestamp: new Date().toISOString()
      });
    }
  }

  return logs;
}

// ========== API ENDPOINTS ==========

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Complete pipeline: ingest + chunk + extract + validate + report
app.post('/api/process', async (req, res) => {
  try {
    const { url, useAI = false, mock = false } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'Missing URL parameter' });
    }

    console.log(`\n[INIT] Starting pipeline for: ${url}`);
    const docId = extractDocId(url);

    const result = {
      docId,
      logs: [],
      data: null,
      report: null,
      error: null
    };

    try {
      console.log('\n[STEP 1] Ingesting...');
      const ingestOutput = await runCommand('./ingest.js', [url, '--out', 'data/']);
      result.logs.push(...parseProgress(ingestOutput.stdout));

      console.log('\n[STEP 2] Chunking...');
      const chunkOutput = await runCommand('./chunk.js', [docId, '--target', '3000', '--overlap', '200']);
      result.logs.push(...parseProgress(chunkOutput.stdout));

      console.log('\n[STEP 3] Extracting...');
      const extractCmd = useAI ? './extract-ai.js' : './extract.js';
      const extractArgs = [
        docId,
        '--schema', 'schemas/gold-schema-v1.json',
        '--out', 'data/extracted'
      ];

      if (useAI && mock) {
        extractArgs.push('--mock');
      }

      const extractOutput = await runCommand(extractCmd, extractArgs);
      result.logs.push(...parseProgress(extractOutput.stdout));

      // Step 4: Validate
      console.log('\n[STEP 4] Validating...');
      const jsonPath = path.join(__dirname, 'data', 'extracted', `${docId}${useAI ? '_ai' : ''}.json`);

      try {
        const validateOutput = await runCommand('./validate.js', [
          jsonPath,
          '--schema', 'schemas/gold-schema-v1.json'
        ]);
        result.logs.push(...parseProgress(validateOutput.stdout));
      } catch (err) {
        console.warn('[WARN] Validation had issues:', err.message);
        result.logs.push({
          message: `[WARN] Validation warnings: ${err.message}`,
          type: 'warning',
          timestamp: new Date().toISOString()
        });
      }

      // Step 5: Load extracted data
      console.log('\n[STEP 5] Loading results...');
      if (await fs.pathExists(jsonPath)) {
        result.data = await fs.readJson(jsonPath);
      }

      // Step 6: Generate report
      console.log('\n[STEP 6] Generating report...');
      if (result.data) {
        result.report = generateReport(result.data, docId);
      }

      result.logs.push({
        message: '[SUCCESS] Pipeline complete',
        type: 'success',
        timestamp: new Date().toISOString()
      });

      res.json(result);

    } catch (err) {
      console.error('[ERROR] Pipeline error:', err);
      result.error = err.message;
      result.logs.push({
        message: `[ERROR] ${err.message}`,
        type: 'error',
        timestamp: new Date().toISOString()
      });
      res.status(500).json(result);
    }

  } catch (err) {
    console.error('[ERROR] Request error:', err);
    res.status(400).json({ error: err.message });
  }
});


app.post('/api/ingest', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing URL' });

    const docId = extractDocId(url);
    const output = await runCommand('./ingest.js', [url, '--out', 'data/']);

    const manifestPath = path.join(__dirname, 'data', 'raw', docId, 'manifest.json');
    const manifest = await fs.pathExists(manifestPath)
      ? await fs.readJson(manifestPath)
      : null;

    res.json({
      docId,
      logs: parseProgress(output.stdout),
      manifest
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chunk', async (req, res) => {
  try {
    const { docId, target = 3000, overlap = 200 } = req.body;
    if (!docId) return res.status(400).json({ error: 'Missing docId' });

    const output = await runCommand('./chunk.js', [
      docId,
      '--target', String(target),
      '--overlap', String(overlap)
    ]);

    const indexPath = path.join(__dirname, 'data', 'chunks', docId, 'index.json');
    const index = await fs.pathExists(indexPath)
      ? await fs.readJson(indexPath)
      : null;

    res.json({
      docId,
      logs: parseProgress(output.stdout),
      index
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/extract', async (req, res) => {
  try {
    const { docId } = req.body;
    if (!docId) return res.status(400).json({ error: 'Missing docId' });

    const output = await runCommand('./extract.js', [
      docId,
      '--schema', 'schemas/gold-schema-v1.json',
      '--out', 'data/extracted'
    ]);

    const jsonPath = path.join(__dirname, 'data', 'extracted', `${docId}.json`);
    const data = await fs.pathExists(jsonPath)
      ? await fs.readJson(jsonPath)
      : null;

    res.json({
      docId,
      logs: parseProgress(output.stdout),
      data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/extract-ai', async (req, res) => {
  try {
    const { docId, mock = false } = req.body;
    if (!docId) return res.status(400).json({ error: 'Missing docId' });

    const args = [
      docId,
      '--schema', 'schemas/gold-schema-v1.json',
      '--out', 'data/extracted'
    ];

    if (mock) args.push('--mock');

    const output = await runCommand('./extract-ai.js', args);

    const jsonPath = path.join(__dirname, 'data', 'extracted', `${docId}_ai.json`);
    const data = await fs.pathExists(jsonPath)
      ? await fs.readJson(jsonPath)
      : null;

    res.json({
      docId,
      logs: parseProgress(output.stdout),
      data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/validate', async (req, res) => {
  try {
    const { docId, isAI = false } = req.body;
    if (!docId) return res.status(400).json({ error: 'Missing docId' });

    const jsonPath = path.join(
      __dirname,
      'data',
      'extracted',
      `${docId}${isAI ? '_ai' : ''}.json`
    );

    if (!await fs.pathExists(jsonPath)) {
      return res.status(404).json({ error: 'Extraction not found' });
    }

    const output = await runCommand('./validate.js', [
      jsonPath,
      '--schema', 'schemas/gold-schema-v1.json'
    ]);

    res.json({
      docId,
      valid: true,
      logs: parseProgress(output.stdout)
    });
  } catch (err) {
    res.json({
      docId: req.body.docId,
      valid: false,
      error: err.message,
      logs: parseProgress(err.message)
    });
  }
});

app.get('/api/report/:docId', async (req, res) => {
  try {
    const { docId } = req.params;
    const { ai } = req.query;

    const jsonPath = path.join(
      __dirname,
      'data',
      'extracted',
      `${docId}${ai === 'true' ? '_ai' : ''}.json`
    );

    if (!await fs.pathExists(jsonPath)) {
      return res.status(404).json({ error: 'Extraction not found' });
    }

    const data = await fs.readJson(jsonPath);
    const report = generateReport(data, docId);

    res.json({ docId, report, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/download/:docId', async (req, res) => {
  try {
    const { docId } = req.params;
    const { ai } = req.query;

    const jsonPath = path.join(
      __dirname,
      'data',
      'extracted',
      `${docId}${ai === 'true' ? '_ai' : ''}.json`
    );

    if (!await fs.pathExists(jsonPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const data = await fs.readJson(jsonPath);
    const filename = `${data.doc?.cik || docId}_${data.doc?.accession || 'extraction'}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/extractions', async (req, res) => {
  try {
    const extractedDir = path.join(__dirname, 'data', 'extracted');
    await fs.ensureDir(extractedDir);

    const files = await fs.readdir(extractedDir);
    const extractions = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(extractedDir, file);
        const data = await fs.readJson(filePath);

        extractions.push({
          docId: file.replace(/(_ai)?\.json$/, ''),
          filename: file,
          isAI: file.includes('_ai'),
          companyName: data.doc?.companyName,
          filedDate: data.doc?.filedDate,
          eventKind: data.event?.kind,
          totalValueUSD: data.event?.totalValueUSD,
          timestamp: (await fs.stat(filePath)).mtime
        });
      }
    }

    extractions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({ extractions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function generateReport(data, docId) {
  const docs = data.provenance?.documents || [];
  const evidence = data.evidence || [];

  let totalFields = 0;
  const SKIP_FIELDS = new Set(['evidence', 'validation', 'provenance']);

  function countFields(obj, prefix = '') {
    for (const [key, val] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (SKIP_FIELDS.has(path)) continue;

      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        countFields(val, path);
      } else if (val !== null && val !== undefined && val !== '' && !Array.isArray(val)) {
        totalFields++;
      }
    }
  }

  countFields(data);

  const coverage = totalFields > 0
    ? ((evidence.length / totalFields) * 100).toFixed(1)
    : 0;

  // --- FIXED Exhibit counting logic with docId parameter ---
  let exhibitCount = docs.filter(
    d =>
      d.role === 'exhibit' ||
      d.type === 'exhibit' ||
      (d.filename && /ex/i.test(d.filename))
  ).length;

  // If no exhibits found, fall back to manifest.json
  if (exhibitCount === 0 && docId) {
    try {
      const cik = data.doc?.cik;
      const accession = data.doc?.accession;
      
      if (cik && accession) {
        // Try both normalized and raw formats
        const accessionRaw = accession.replace(/-/g, '');
        
        // Use the base docId WITHOUT _ai suffix
        const baseDocId = docId.replace(/_ai$/, '');
        const baseDocIds = [
          baseDocId,                    // Use the passed docId directly
          `${cik}-${accession}`,        // normalized format
          `${cik}-${accessionRaw}`      // raw format
        ];

        for (const currentDocId of baseDocIds) {
          const manifestPath = path.resolve(__dirname, 'data', 'raw', currentDocId, 'manifest.json');
          
          console.log(`[DEBUG] Checking manifest at: ${manifestPath}`);
          
          if (fs.existsSync(manifestPath)) {
            console.log(`[DEBUG] Found manifest at: ${manifestPath}`);
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            
            if (manifest.files?.length) {
              exhibitCount = manifest.files.filter(
                f => f.role && f.role.toLowerCase() === 'exhibit'
              ).length;
              console.log(`[INFO] Exhibit count from manifest (${currentDocId}): ${exhibitCount}`);
              break; // Found it, stop trying
            }
          } else {
            console.log(`[DEBUG] Manifest not found at: ${manifestPath}`);
          }
        }
      } else {
        console.warn('[WARN] Missing CIK or accession in extracted data');
      }
    } catch (err) {
      console.warn('[WARN] Could not read manifest for exhibit count:', err.message);
      console.warn('[WARN] Stack:', err.stack);
    }
  }

  console.log(`[DEBUG] Final exhibit count: ${exhibitCount}`);

  return {
    eventKind: data.event?.kind || 'Unknown',
    secItem: data.event?.secItem || 'Unknown',
    totalValueUSD: data.event?.totalValueUSD || 0,
    upfrontUSD: data.partnership?.upfrontPaymentUSD || data.deal?.purchasePriceUSD || 0,
    milestonesUSD: data.partnership?.milestonesUSD || 0,
    exhibitCount,
    totalDocs: docs.length + exhibitCount,
    evidenceCount: evidence.length,
    totalFields,
    coveragePercent: parseFloat(coverage),
    hasValidationIssues:
      (data.validation?.hardConstraints?.length || 0) +
      (data.validation?.crossField?.length || 0) >
      0,
    hardConstraints: data.validation?.hardConstraints || [],
    crossFieldIssues: data.validation?.crossField || [],
    companyName: data.doc?.companyName,
    filedDate: data.doc?.filedDate,
    effectiveDate: data.event?.effectiveDate,
  };
}

app.use((err, req, res, next) => {
  console.error('[ERROR] Server error:', err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n[SERVER] SEC Extraction API Server running on port ${PORT}`);
  console.log(`\n[API] Endpoints:`);
  console.log(`   GET  /api/health`);
  console.log(`   POST /api/process - Full pipeline`);
  console.log(`   POST /api/ingest - Ingest filing`);
  console.log(`   POST /api/chunk - Chunk document`);
  console.log(`   POST /api/extract - Extract (rule-based)`);
  console.log(`   POST /api/extract-ai - Extract (AI)`);
  console.log(`   POST /api/validate - Validate output`);
  console.log(`   GET  /api/report/:docId - Get report`);
  console.log(`   GET  /api/download/:docId - Download JSON`);
  console.log(`   GET  /api/extractions - List all extractions`);
  console.log(`\n[EXAMPLE] Usage:`);
  console.log(`   curl -X POST http://localhost:${PORT}/api/process \\`);
  console.log(`     -H "Content-Type: application/json" \\`);
  console.log(`     -d '{"url":"https://www.sec.gov/Archives/edgar/data/..."}'`);
  console.log();
});

export default app;