#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const program = new Command();

program
    .name("extract")
    .description("Extract data from SEC 8-K documents using manual rules or AI")
    .argument("<doc_id>", "Document ID")
    .requiredOption("--schema <path>", "Path to JSON schema")
    .option("--out <dir>", "Output directory", "data/extracted")
    .option("--mode <type>", "Extraction mode: 'manual' or 'ai'", "manual")
    .option("--mock", "Use mock mode for AI (no API calls)")
    .option("--max-retries <n>", "Max retry attempts for AI", "3")
    .option("--timeout <ms>", "Request timeout in ms for AI", "120000")
    .option("--demo <path>", "Path to demo/example JSON for AI", "schemas/demo-schema-v1.json")
    .parse(process.argv);

const [docId] = program.args;
const opts = program.opts();

function runExtractor(scriptName, args) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, scriptName);
        
        console.log(`\nRunning ${scriptName}...`);
        console.log(`   Mode: ${opts.mode}`);
        console.log(`   Doc ID: ${docId}`);
        console.log(`   Schema: ${opts.schema}`);
        console.log(`   Output: ${opts.out}\n`);
        
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
            
        } else if (opts.mode === "manual") {
            const manualArgs = [
                docId,
                "--schema", opts.schema,
                "--out", opts.out
            ];
            
            await runExtractor("extract-manual.js", manualArgs);
            
        } else {
            console.error(`Invalid mode: ${opts.mode}`);
            console.error(`   Valid modes: 'manual', 'ai'`);
            process.exit(1);
        }
        
        console.log(`\nExtraction completed successfully!`);
        
    } catch (err) {
        console.error(`\nExtraction failed: ${err.message}`);
        process.exit(1);
    }
}

main();