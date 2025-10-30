#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const program = new Command();

program
    .name("extract")
    .description("Extract data from SEC 8-K documents using manual rules, cloud AI, or local LLM")
    .argument("<doc_id>", "Document ID")
    .requiredOption("--schema <path>", "Path to JSON schema")
    .option("--out <dir>", "Output directory", "data/extracted")
    .option("--mode <type>", "Extraction mode: 'manual', 'ai', or 'local'", "manual")
    .option("--mock", "Use mock mode for AI (no API calls)")
    .option("--max-retries <n>", "Max retry attempts for AI", "3")
    .option("--timeout <ms>", "Request timeout in ms for AI", "120000")
    .option("--demo <path>", "Path to demo/example JSON for AI", "schemas/demo-schema-v1.json")
    // Local LLM options
    .option("--llm-url <url>", "Local LLM endpoint URL", "http://localhost:11434/api/generate")
    .option("--llm-model <name>", "Local LLM model name", "llama3.2")
    .option("--llm-temperature <n>", "Temperature for local LLM", "0.1")
    .option("--llm-max-tokens <n>", "Max tokens for local LLM", "4096")
    .parse(process.argv);

const [docId] = program.args;
const opts = program.opts();

function runExtractor(scriptName, args) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, scriptName);

        console.log(`\n🚀 Running ${scriptName}...`);
        console.log(`   Mode: ${opts.mode}`);
        console.log(`   Doc ID: ${docId}`);
        console.log(`   Schema: ${opts.schema}`);
        console.log(`   Output: ${opts.out}`);

        if (opts.mode === "local") {
            console.log(`   LLM URL: ${opts.llmUrl}`);
            console.log(`   LLM Model: ${opts.llmModel}`);
        }
        console.log("");

        const child = spawn("node", [scriptPath, ...args], {
            stdio: "inherit",
            env: process.env
        });

        child.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${scriptName} exited with code ${code}`));
            }
        });

        child.on("error", (err) => {
            reject(new Error(`Failed to start ${scriptName}: ${err.message}`));
        });
    });
}

async function main() {
    try {
        if (opts.mode === "ai") {
            const aiArgs = [
                docId,
                "--schema", opts.schema,
                "--out", opts.out,
                "--max-retries", opts.maxRetries,
                "--timeout", opts.timeout,
                "--demo", opts.demo
            ];

            if (opts.mock) {
                aiArgs.push("--mock");
            }

            await runExtractor("extract-ai.js", aiArgs);

        } else if (opts.mode === "local") {
            const localArgs = [
                docId,
                "--schema", opts.schema,
                "--out", opts.out,
                "--llm-url", opts.llmUrl,
                "--llm-model", opts.llmModel,
                "--llm-temperature", opts.llmTemperature,
                "--llm-max-tokens", opts.llmMaxTokens,
                "--max-retries", opts.maxRetries,
                "--timeout", opts.timeout, 
                "--demo", opts.demo
            ];

            await runExtractor("extract-local-llm.js", localArgs);

        } else if (opts.mode === "manual") {
            // Manual rule-based extraction
            const manualArgs = [
                docId,
                "--schema", opts.schema,
                "--out", opts.out
            ];

            await runExtractor("extract-manual.js", manualArgs);

        } else {
            console.error(`❌ Invalid mode: ${opts.mode}`);
            console.error(`   Valid modes: 'manual', 'ai', 'local'`);
            process.exit(1);
        }

        console.log(`\n✅ Extraction completed successfully!`);

    } catch (err) {
        console.error(`\n❌ Extraction failed: ${err.message}`);
        process.exit(1);
    }
}

main();