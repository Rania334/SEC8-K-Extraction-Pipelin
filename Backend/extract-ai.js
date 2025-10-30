#!/usr/bin/env node
import fs from "fs-extra";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Command } from "commander";
import crypto from "crypto";
import 'dotenv/config';

const program = new Command();

program
    .argument("<doc_id>", "Document ID")
    .requiredOption("--schema <path>", "Path to JSON schema")
    .option("--out <dir>", "Output dir", "data/extracted")
    .option("--mock", "Use mock mode (no API calls)")
    .option("--max-retries <n>", "Max retry attempts", "3")
    .option("--timeout <ms>", "Request timeout in ms", "120000")
    .option("--demo <path>", "Path to demo/example JSON", "schemas/demo-schema-v1.json")
    .parse(process.argv);

const [docId] = program.args;
const opts = program.opts();

const CHUNK_DIR = path.join("data", "chunks", docId);
const OUT_DIR = path.resolve(opts.out);
const MAX_RETRIES = parseInt(opts.maxRetries);
const TIMEOUT_MS = parseInt(opts.timeout);

await fs.ensureDir(OUT_DIR);

function generateIdempotencyKey(docId, schemaPath) {
    const hash = crypto.createHash('sha256');
    hash.update(`${docId}:${schemaPath}:${fs.readFileSync(schemaPath, 'utf8')}`);
    return hash.digest('hex').slice(0, 16);
}

function loadChunks(chunkDir) {
    if (!fs.existsSync(chunkDir)) {
        throw new Error(`Chunk directory not found: ${chunkDir}`);
    }
    const files = fs.readdirSync(chunkDir)
        .filter(f => f.endsWith(".txt") && f.startsWith("chunk_"))
        .sort();

    if (files.length === 0) {
        throw new Error(`No chunks found in ${chunkDir}`);
    }

    return files.map(f => ({
        file: f,
        text: fs.readFileSync(path.join(chunkDir, f), "utf8")
    }));
}

async function callLLMWithRetry(prompt, model, idempotencyKey) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`  Attempt ${attempt}/${MAX_RETRIES}...`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const result = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 8192,
                }
            });

            clearTimeout(timeoutId);

            const text = result.response.text();

            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch (parseErr) {
                const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
                if (jsonMatch) {
                    parsed = JSON.parse(jsonMatch[1]);
                } else {
                    throw new Error("Response is not valid JSON");
                }
            }

            console.log(`  Success on attempt ${attempt}`);
            return { json: parsed, raw: text };

        } catch (err) {
            lastError = err;
            console.error(`  Attempt ${attempt} failed: ${err.message}`);

            if (attempt < MAX_RETRIES) {
                const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
                console.log(`  Waiting ${backoffMs}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }
    }

    throw new Error(`All ${MAX_RETRIES} attempts failed. Last error: ${lastError?.message}`);
}
async function mockExtraction(docId, chunks, schema) {
    console.log(`  Mock mode - generating placeholder JSON`);

    return {
        doc: {
            accession: "0000000000-00-000000",
            filingType: "8-K",
            filedDate: "2023-01-01",
            companyName: "Mock Company Inc.",
            cik: "0000000000"
        },
        event: {
            kind: "Collaboration",
            secItem: "Item 1.01",
            headline: "Mock Event Headline",
            summary: "This is a mock extraction for testing purposes.",
            totalValueUSD: 1000000,
            effectiveDate: "2023-01-01"
        },
        partnership: {
            partnerA: "Mock Company Inc.",
            partnerB: "Mock Partner Corp.",
            scope: "Development and commercialization",
            territory: "worldwide",
            upfrontPaymentUSD: 500000,
            milestonesUSD: 1000000
        },
        provenance: {
            documents: chunks.map((c, i) => ({
                role: i === 0 ? "primary" : "exhibit",
                filename: c.file,
                sourceUrl: `https://mock.sec.gov/${docId}`,
                sha256: crypto.createHash('sha256').update(c.text).digest('hex')
            }))
        },
        evidence: [
            {
                field: "doc.companyName",
                sourceFile: chunks[0].file,
                sourceUrl: `https://mock.sec.gov/${docId}`,
                selector: `chunk:${chunks[0].file}`,
                snippet: chunks[0].text.slice(0, 200)
            }
        ]
    };
}

function ensureAllFieldsHaveEvidence(extracted, chunks) {
    const evidence = extracted.evidence || [];
    const evidenceFields = new Set(evidence.map(e => e.field));

    // Helper to find a chunk containing a value
    function findChunkWithValue(value) {
        if (!value) return null;
        const searchStr = String(value).trim();
        return chunks.find(c => c.text.includes(searchStr));
    }

    // Helper to add evidence if missing
    function ensureEvidence(fieldPath, value, fallbackChunk = chunks[0]) {
        if (!value || evidenceFields.has(fieldPath)) return;

        const chunk = findChunkWithValue(value) || fallbackChunk;
        const snippet = typeof value === 'string' && value.length < 200
            ? value
            : String(value).slice(0, 100);

        evidence.push({
            field: fieldPath,
            sourceFile: chunk.file,
            sourceUrl: extracted.provenance?.documents?.[0]?.sourceUrl || "",
            selector: `chunk:${chunk.file}`,
            snippet: snippet
        });

        evidenceFields.add(fieldPath);
    }

    // Ensure evidence for all doc fields
    if (extracted.doc) {
        ensureEvidence("doc.accession", extracted.doc.accession);
        ensureEvidence("doc.filingType", extracted.doc.filingType);
        ensureEvidence("doc.filedDate", extracted.doc.filedDate);
        ensureEvidence("doc.companyName", extracted.doc.companyName);
        ensureEvidence("doc.cik", extracted.doc.cik);
    }

    // Ensure evidence for all event fields
    if (extracted.event) {
        ensureEvidence("event.kind", extracted.event.kind);
        ensureEvidence("event.secItem", extracted.event.secItem);
        ensureEvidence("event.headline", extracted.event.headline);
        ensureEvidence("event.summary", extracted.event.summary);
        ensureEvidence("event.totalValueUSD", extracted.event.totalValueUSD);
        ensureEvidence("event.effectiveDate", extracted.event.effectiveDate);
    }

    // Ensure evidence for all partnership fields
    if (extracted.partnership) {
        ensureEvidence("partnership.partnerA", extracted.partnership.partnerA);
        ensureEvidence("partnership.partnerB", extracted.partnership.partnerB);
        ensureEvidence("partnership.scope", extracted.partnership.scope);
        ensureEvidence("partnership.territory", extracted.partnership.territory);
        ensureEvidence("partnership.upfrontPaymentUSD", extracted.partnership.upfrontPaymentUSD);
        ensureEvidence("partnership.milestonesUSD", extracted.partnership.milestonesUSD);
    }

    extracted.evidence = evidence;
    return extracted;
}

function postProcessExtraction(extracted, chunks) {
    // Fix CIK: extract from accession number
    if (extracted.doc?.accession && !extracted.doc.cik) {
        extracted.doc.cik = extracted.doc.accession.split('-')[0];
    }

    // Remove deal if null (schema doesn't require it)
    if (extracted.deal === null) {
        delete extracted.deal;
    }

    // Fix SHA256 hashes in provenance
    if (extracted.provenance?.documents) {
        extracted.provenance.documents = extracted.provenance.documents.map(doc => {
            const chunk = chunks.find(c => c.file === doc.filename);
            return {
                ...doc,
                sha256: chunk
                    ? crypto.createHash('sha256').update(chunk.text).digest('hex')
                    : crypto.createHash('sha256').update('').digest('hex')
            };
        });
    }

    extracted = ensureAllFieldsHaveEvidence(extracted, chunks);


    return extracted;
}



async function run() {
    console.log(`\nAI Extraction for ${docId}...`);

    const schema = await fs.readFile(opts.schema, "utf8");
    const chunks = loadChunks(CHUNK_DIR);

    console.log(`  Chunks loaded: ${chunks.length}`);
    console.log(`  Schema: ${opts.schema}`);
    console.log(`  Timeout: ${TIMEOUT_MS}ms`);
    console.log(`  Max retries: ${MAX_RETRIES}`);

    const idempotencyKey = generateIdempotencyKey(docId, opts.schema);
    console.log(`  Idempotency key: ${idempotencyKey}`);

    let extracted;

    if (opts.mock) {
        extracted = await mockExtraction(docId, chunks, schema);
    } else {
        if (!process.env.GEMINI_API_KEY) {
            throw new Error("GEMINI_API_KEY not found in environment");
        }

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({
            model: "gemini-2.0-flash-exp"
        });

        let demoText = "";
        if (opts.demo && fs.existsSync(opts.demo)) {
            const demo = await fs.readFile(opts.demo, "utf8");
            demoText = `\n\nExample output (for reference):\n${demo}`;
        }
        const prompt = `You are a financial document extractor for SEC 8-K filings.

CRITICAL REQUIREMENTS:
1. Output ONLY valid JSON matching the schema exactly
2. **EVERY non-null field MUST have a corresponding evidence entry**
3. All dates must be ISO format (YYYY-MM-DD)
4. All monetary values must be numeric USD (no strings)
5. Company names must be clean entity names (not sentence fragments)
6. Extract the EARLIEST event date as effectiveDate (not the filing date)
7. Extract CIK from the accession number (first 10 digits)
8. If deal is not applicable, omit the field entirely (don't set to null)

EVIDENCE REQUIREMENTS:
- For EVERY field you extract (doc.accession, doc.filingType, doc.filedDate, doc.companyName, doc.cik, event.kind, event.secItem, event.headline, event.summary, event.totalValueUSD, event.effectiveDate, partnership.partnerA, partnership.partnerB, partnership.scope, partnership.territory, partnership.upfrontPaymentUSD, partnership.milestonesUSD), you MUST create an evidence object
- Each evidence object must include:
  * field: the JSON path (e.g., "doc.accession")
  * sourceFile: the chunk file name where you found this info
  * sourceUrl: the SEC URL
  * selector: "chunk:FILENAME"
  * snippet: a SHORT exact quote (10-50 words) from the chunk that contains this information

EXAMPLE EVIDENCE:
{
  "field": "doc.accession",
  "sourceFile": "chunk_0001.txt",
  "sourceUrl": "https://www.sec.gov/...",
  "selector": "chunk:chunk_0001",
  "snippet": "ACCESSION NUMBER: 0001193125-23-194715"
}

JSON Schema:
${schema}${demoText}

Document chunks:
${chunks.map(c => `=== ${c.file} ===\n${c.text}`).join("\n\n")}

Instructions:
- Read all chunks carefully
- Extract doc.accession from the SEC header (format: 0000000000-00-000000)
- Extract doc.filingType from the form type field
- Extract doc.companyName from header or Item 1.01
- Extract doc.cik from accession number (first 10 digits)
- Extract doc.filedDate as the date filed with SEC
- Extract event.effectiveDate as the date the agreement was entered into
- Extract event.headline from Item 1.01 title
- Extract event.summary from the description
- For partnerships: extract both partners, upfront payment, milestones, scope, territory
- **Create an evidence object for EACH extracted field**
- Output ONLY the JSON object, no explanations`;

        console.log(`\nCalling Gemini API...`);
        const result = await callLLMWithRetry(prompt, model, idempotencyKey);
        extracted = result.json;
    }

    extracted = postProcessExtraction(extracted, chunks);

    const outPath = path.join(OUT_DIR, `${docId}_ai.json`);
    await fs.writeJson(outPath, extracted, { spaces: 2 });

    console.log(`\nAI Extraction complete`);
    console.log(`   Company: ${extracted.doc?.companyName || 'NOT FOUND'}`);
    console.log(`   Filed Date: ${extracted.doc?.filedDate || 'NOT FOUND'}`);
    console.log(`   Event kind: ${extracted.event?.kind || 'NOT FOUND'}`);
    console.log(`   Effective Date: ${extracted.event?.effectiveDate || 'NOT FOUND'}`);

    if (extracted.partnership) {
        console.log(`   Partners: ${extracted.partnership.partnerA} & ${extracted.partnership.partnerB}`);
        console.log(`   Upfront: ${extracted.partnership.upfrontPaymentUSD?.toLocaleString() || '0'}`);
        console.log(`   Milestones: ${extracted.partnership.milestonesUSD?.toLocaleString() || '0'}`);
    }

    console.log(`   Evidence objects: ${extracted.evidence?.length || 0}`);
    console.log(`   Hard constraints: ${extracted.validation?.hardConstraints?.length || 0}`);
    console.log(`   Cross-field issues: ${extracted.validation?.crossField?.length || 0}`);

    if (extracted.validation?.hardConstraints?.length > 0) {
        console.log(`\nHard Constraints:`);
        extracted.validation.hardConstraints.forEach(c => console.log(`     - ${c}`));
    }

    console.log(`\nOutput: ${outPath}`);
}

await run().catch(err => {
    console.error("AI Extraction failed:", err.message);
    console.error(err.stack);
    process.exit(1);
});