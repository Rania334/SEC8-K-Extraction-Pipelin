#!/usr/bin/env node
import fs from "fs-extra";
import path from "path";
import { Command } from "commander";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const program = new Command();

program
    .argument("<json_path>", "Path to output JSON (e.g., data/extracted/1178670.json)")
    .option("--schema <schema_path>", "Path to schema JSON file")
    .parse(process.argv);

const [jsonPath] = program.args;
const opts = program.opts();

if (!opts.schema) {
    console.error("❌ Missing --schema option");
    process.exit(1);
}

const SCHEMA_PATH = opts.schema;

async function main() {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);

    const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, "utf-8"));
    const data = JSON.parse(await fs.readFile(jsonPath, "utf-8"));

    const validate = ajv.compile(schema);
    const valid = validate(data);

    if (!valid) {
        console.error("Schema validation failed:");
        console.error(validate.errors);
        process.exit(1);
    }

    console.log("✅ Schema validation passed.");

    const evidence = data.evidence || [];

    const docId = path.basename(jsonPath, '.json');
    const baseId = docId.replace(/_(ai)$/, "");
    const chunkDir = path.join("data", "chunks", baseId);

    console.log("───────────────────────────────────────────────");
    console.log(`📄  Validating document: ${docId}`);
    console.log("───────────────────────────────────────────────");
    console.log(`   Looking for chunks in: ${chunkDir}`);

    if (!fs.existsSync(chunkDir)) {
        console.error(`❌ Chunk directory not found: ${chunkDir}`);
        process.exit(1);
    }

    const errors = [];

    const SKIP_FIELDS = new Set([
        'evidence',
        'validation',
        'validation.hardConstraints',
        'validation.crossField',
        'provenance',
        'provenance.documents'
    ]);

    function checkField(fieldPath, value) {
        if (SKIP_FIELDS.has(fieldPath)) return;
        if (value === null || value === undefined || value === "") return;

        if (typeof value === "object") return;

        const evRows = evidence.filter(e => e.field === fieldPath);
        if (evRows.length === 0) {
            errors.push(`⚠️ No evidence found for non-null field: ${fieldPath}`);
            return;
        }

        for (const ev of evRows) {
            const chunkFile = path.join(chunkDir, ev.sourceFile);
            if (!fs.existsSync(chunkFile)) {
                errors.push(`❌ Missing chunk file: ${chunkFile}`);
                continue;
            }

            const chunkText = fs.readFileSync(chunkFile, "utf-8");
            if (!chunkText.includes(ev.snippet.trim())) {
                errors.push(`❌ Evidence snippet not found in ${ev.sourceFile} for field ${fieldPath}`);
            }
        }
    }
    function walk(obj, prefix = "") {
        for (const [key, val] of Object.entries(obj)) {
            const fieldPath = prefix ? `${prefix}.${key}` : key;

            if (typeof val === "object" && val !== null && !Array.isArray(val)) {
                walk(val, fieldPath);
            } else if (!Array.isArray(val)) {
                checkField(fieldPath, val);
            }
        }
    }

    walk(data);

    if (errors.length > 0) {
        console.error("\n❌ Validation failed with issues:");
        for (const e of errors) console.error(" - " + e);
        process.exit(1);
    }

    console.log("🧩 All non-null fields have valid evidence snippets.");
    console.log("✨ Validation complete — everything looks great!");
    console.log("───────────────────────────────────────────────");
}

await main();