#!/usr/bin/env node
import fs from "fs-extra";
import path from "path";
import { Command } from "commander";
import crypto from "crypto";

const program = new Command();

program
    .argument("<doc_id>", "Document ID")
    .requiredOption("--schema <path>", "Path to JSON schema")
    .option("--out <dir>", "Output dir", "data/extracted")
    .option("--llm-url <url>", "Local LLM endpoint", "http://localhost:11434/api/generate")
    .option("--llm-model <n>", "Model name", "llama3.2")
    .option("--llm-temperature <n>", "Temperature", "0.1")
    .option("--llm-max-tokens <n>", "Max tokens", "8192")
    .option("--max-retries <n>", "Max retries", "3")
    .option("--demo <path>", "Demo JSON path", "schemas/demo-schema-v1.json")
    .option("--timeout <ms>", "Request timeout", "300000")
    .parse(process.argv);

const [docId] = program.args;
const opts = program.opts();

const RAW_DIR = path.join("data", "raw", docId);
const CHUNK_DIR = path.join("data", "chunks", docId);
const OUT_DIR = path.resolve(opts.out);
const MAX_RETRIES = parseInt(opts.maxRetries) || 3;
const TIMEOUT_MS = parseInt(opts.timeout) || 300000;

await fs.ensureDir(OUT_DIR);

/* ---------- Local LLM Client ---------- */

class LocalLLMClient {
    constructor(config) {
        this.url = config.url;
        this.model = config.model;
        this.temperature = parseFloat(config.temperature) || 0.1;
        this.maxTokens = parseInt(config.maxTokens) || 8192;
    }

    async generate(prompt, options = {}) {
        const payload = {
            model: this.model,
            prompt: prompt,
            stream: false,
            options: {
                temperature: options.temperature || this.temperature,
                num_predict: options.maxTokens || this.maxTokens,
            }
        };

        console.log(`\n🤖 Calling local LLM (${this.model})...`);
        console.log(`   URL: ${this.url}`);
        console.log(`   Prompt length: ${prompt.length} chars`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            const response = await fetch(this.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`LLM request failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json();

            if (!data.response) {
                throw new Error("No response from LLM");
            }

            console.log(`   ✅ Generated ${data.response.length} chars`);
            console.log(`   Eval count: ${data.eval_count || 'N/A'} tokens`);

            return data.response;

        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error(`Request timeout after ${TIMEOUT_MS}ms`);
            }
            console.error(`   ❌ LLM error: ${error.message}`);
            throw error;
        }
    }

    async extractWithRetry(prompt, maxRetries = 3) {
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`\n📝 Attempt ${attempt}/${maxRetries}...`);

                const response = await this.generate(prompt);

                // Try to parse JSON directly first
                let parsed;
                try {
                    parsed = JSON.parse(response);
                } catch (parseErr) {
                    // Try to extract JSON from markdown code blocks
                    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
                    if (jsonMatch) {
                        parsed = JSON.parse(jsonMatch[1]);
                    } else {
                        // Try to find any JSON object in the response
                        const objectMatch = response.match(/\{[\s\S]*\}/);
                        if (objectMatch) {
                            parsed = JSON.parse(objectMatch[0]);
                        } else {
                            throw new Error("No valid JSON found in response");
                        }
                    }
                }

                console.log(`   ✅ Successfully extracted and parsed JSON`);
                return { json: parsed, raw: response };

            } catch (error) {
                lastError = error;
                console.error(`   ⚠️  Attempt ${attempt} failed: ${error.message}`);

                if (attempt < maxRetries) {
                    const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
                    console.log(`   ⏳ Waiting ${backoffMs}ms before retry...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                }
            }
        }

        throw new Error(`All ${maxRetries} attempts failed. Last error: ${lastError.message}`);
    }
}

/* ---------- Helpers ---------- */

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

function buildPrompt(chunks, schema, demoPath) {
    let demoText = "";
    if (demoPath && fs.existsSync(demoPath)) {
        const demo = fs.readFileSync(demoPath, "utf8");
        demoText = `\n\nExample output (for reference):\n${demo}`;
    }

    // Limit total chunk text to avoid token limits
    const maxChunkLength = 6000;
    const chunksText = chunks
        .map(c => `=== ${c.file} ===\n${c.text}`)
        .join("\n\n")
        .slice(0, maxChunkLength);

    const prompt = `Extract information from this SEC 8-K filing and return ONLY valid JSON.

JSON Schema:
${schema}

Document chunks:
${chunksText}

OUTPUT (JSON only):`;

    return prompt;
}

function ensureAllFieldsHaveEvidence(extracted, chunks) {
    const evidence = extracted.evidence || [];
    const evidenceFields = new Set(evidence.map(e => e.field));

    function findChunkWithValue(value) {
        if (!value) return null;
        const searchStr = String(value).trim();
        return chunks.find(c => c.text.includes(searchStr));
    }

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

    if (extracted.doc) {
        ensureEvidence("doc.accession", extracted.doc.accession);
        ensureEvidence("doc.filingType", extracted.doc.filingType);
        ensureEvidence("doc.filedDate", extracted.doc.filedDate);
        ensureEvidence("doc.companyName", extracted.doc.companyName);
        ensureEvidence("doc.cik", extracted.doc.cik);
    }

    if (extracted.event) {
        ensureEvidence("event.kind", extracted.event.kind);
        ensureEvidence("event.secItem", extracted.event.secItem);
        ensureEvidence("event.headline", extracted.event.headline);
        ensureEvidence("event.summary", extracted.event.summary);
        ensureEvidence("event.totalValueUSD", extracted.event.totalValueUSD);
        ensureEvidence("event.effectiveDate", extracted.event.effectiveDate);
    }

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

function postProcessExtraction(extracted, chunks, manifest) {
    // Fix accession if missing
    if (!extracted.doc?.accession && manifest.accession_guess) {
        extracted.doc = extracted.doc || {};
        extracted.doc.accession = manifest.accession_guess;
    }

    // Fix CIK: extract from accession number
    if (extracted.doc?.accession && !extracted.doc.cik) {
        extracted.doc.cik = extracted.doc.accession.split('-')[0];
    }

    // Remove deal if null
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

    // Ensure all fields have evidence
    extracted = ensureAllFieldsHaveEvidence(extracted, chunks);

    return extracted;
}

/* ---------- Main ---------- */

async function run() {
    console.log(`\n📄 Local LLM Extraction for ${docId}...`);

    const manifestPath = path.join(RAW_DIR, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
        console.error("❌ manifest.json not found in", RAW_DIR);
        process.exit(1);
    }

    const manifest = await fs.readJson(manifestPath);
    const schema = await fs.readFile(opts.schema, "utf8");
    const chunks = loadChunks(CHUNK_DIR);

    console.log(`  Chunks loaded: ${chunks.length}`);
    console.log(`  Total text: ${chunks.reduce((sum, c) => sum + c.text.length, 0)} chars`);
    console.log(`  Schema: ${opts.schema}`);
    console.log(`  Timeout: ${TIMEOUT_MS}ms`);
    console.log(`  Max retries: ${MAX_RETRIES}`);

    // Initialize local LLM client
    const llm = new LocalLLMClient({
        url: opts.llmUrl,
        model: opts.llmModel,
        temperature: opts.llmTemperature,
        maxTokens: opts.llmMaxTokens
    });

    // Build prompt
    const prompt = buildPrompt(chunks, schema, opts.demo);
    console.log(`\n📝 Prompt built: ${prompt.length} chars`);

    // Extract with retry
    const result = await llm.extractWithRetry(prompt, MAX_RETRIES);
    let extracted = result.json;

    // Post-process
    extracted = postProcessExtraction(extracted, chunks, manifest);

    // Save output
    const outPath = path.join(OUT_DIR, `${docId}_local.json`);
    await fs.writeJson(outPath, extracted, { spaces: 2 });

    console.log(`\n✅ Local LLM Extraction complete`);
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
        console.log(`\n⚠️  Hard Constraints:`);
        extracted.validation.hardConstraints.forEach(c => console.log(`     - ${c}`));
    }

    console.log(`\n📁 Output: ${outPath}`);
}

await run().catch(err => {
    console.error("❌ Local LLM Extraction failed:", err.message);
    console.error(err.stack);
    process.exit(1);
});