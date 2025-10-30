#!/usr/bin/env node
import fs from "fs-extra";
import path from "path";
import { Command } from "commander";

const program = new Command();

program
    .argument("<doc_id>", "Document ID (e.g., 1178670)")
    .option("--extracted <dir>", "Extracted data directory", "data/extracted")
    .parse(process.argv);

const [docId] = program.args;
const opts = program.opts();

const EXTRACTED_DIR = path.resolve(opts.extracted);

async function main() {
    const jsonPath = path.join(EXTRACTED_DIR, `${docId}.json`);
    
    if (!fs.existsSync(jsonPath)) {
        console.error(`❌ Extracted data not found: ${jsonPath}`);
        process.exit(1);
    }

    const data = await fs.readJson(jsonPath);
    
    console.log(`\n📊 EXTRACTION REPORT FOR ${docId}`);
    console.log(`${'='.repeat(60)}\n`);
    
    // Event Information
    console.log(`📋 Event Information:`);
    console.log(`   Kind: ${data.event?.kind || 'NOT DETECTED'}`);
    console.log(`   SEC Item: ${data.event?.secItem || 'NOT DETECTED'}`);
    
    // Financial Totals
    console.log(`\n💰 Financial Totals:`);
    const totalValue = data.event?.totalValueUSD || 0;
    const upfront = data.partnership?.upfrontPaymentUSD || data.deal?.purchasePriceUSD || 0;
    const milestones = data.partnership?.milestonesUSD || 0;
    
    console.log(`   Total Value: $${totalValue.toLocaleString()}`);
    if (data.partnership) {
        console.log(`   Upfront Payment: $${upfront.toLocaleString()}`);
        console.log(`   Milestone Payments: $${milestones.toLocaleString()}`);
    }
    
    // Exhibit Count
    console.log(`\n📎 Documents:`);
    const docs = data.provenance?.documents || [];
    const exhibits = docs.filter(d => d.role === "exhibit");
    const primary = docs.filter(d => d.role === "primary");
    
    console.log(`   Primary Documents: ${primary.length}`);
    console.log(`   Exhibits: ${exhibits.length}`);
    console.log(`   Total Documents: ${docs.length}`);
    
    // Evidence Coverage
    console.log(`\n🔍 Evidence Coverage:`);
    
    const evidence = data.evidence || [];
    
    // Skip metadata fields when calculating coverage
    const SKIP_FIELDS = new Set([
        'evidence',
        'validation',
        'validation.hardConstraints',
        'validation.crossField',
        'provenance',
        'provenance.documents'
    ]);
    
    // Count non-null primitive fields
    let totalFields = 0;
    let fieldsWithEvidence = 0;
    const fieldsWithoutEvidence = [];
    
    function countFields(obj, prefix = "") {
        for (const [key, val] of Object.entries(obj)) {
            const fieldPath = prefix ? `${prefix}.${key}` : key;
            
            // Skip metadata fields
            if (SKIP_FIELDS.has(fieldPath)) continue;
            
            if (typeof val === "object" && val !== null && !Array.isArray(val)) {
                // Recurse into nested objects
                countFields(val, fieldPath);
            } else if (!Array.isArray(val)) {
                // Only count primitive non-null values
                if (val !== null && val !== undefined && val !== "") {
                    totalFields++;
                    
                    // Check if this field has evidence
                    const hasEvidence = evidence.some(e => e.field === fieldPath);
                    if (hasEvidence) {
                        fieldsWithEvidence++;
                    } else {
                        fieldsWithoutEvidence.push(fieldPath);
                    }
                }
            }
        }
    }
    
    countFields(data);
    
    const coveragePercent = totalFields > 0 
        ? ((fieldsWithEvidence / totalFields) * 100).toFixed(1)
        : 0;
    
    console.log(`   Total Non-Null Fields: ${totalFields}`);
    console.log(`   Fields With Evidence: ${fieldsWithEvidence}`);
    console.log(`   Coverage: ${coveragePercent}%`);
    
    if (fieldsWithoutEvidence.length > 0) {
        console.log(`\n   ⚠️  Fields Without Evidence:`);
        fieldsWithoutEvidence.forEach(f => console.log(`      - ${f}`));
    }
    
    // Partnership Details (if applicable)
    if (data.partnership) {
        console.log(`\n🤝 Partnership Details:`);
        console.log(`   Partner A: ${data.partnership.partnerA || 'NOT FOUND'}`);
        console.log(`   Partner B: ${data.partnership.partnerB || 'NOT FOUND'}`);
        console.log(`   Territory: ${data.partnership.territory || 'NOT FOUND'}`);
        if (data.partnership.scope) {
            const scope = data.partnership.scope.slice(0, 100);
            console.log(`   Scope: ${scope}${data.partnership.scope.length > 100 ? '...' : ''}`);
        }
    }
    
    // Deal Details (if applicable)
    if (data.deal) {
        console.log(`\n💼 Deal Details:`);
        if (data.deal.buyer) console.log(`   Buyer: ${data.deal.buyer}`);
        if (data.deal.seller) console.log(`   Seller: ${data.deal.seller}`);
        if (data.deal.target) console.log(`   Target: ${data.deal.target}`);
    }
    
    // Validation Status
    console.log(`\n✓ Validation Status:`);
    const hardConstraints = data.validation?.hardConstraints || [];
    const crossField = data.validation?.crossField || [];
    
    if (hardConstraints.length === 0 && crossField.length === 0) {
        console.log(`   ✅ No validation issues`);
    } else {
        if (hardConstraints.length > 0) {
            console.log(`   ❌ Hard Constraints: ${hardConstraints.length}`);
            hardConstraints.forEach(c => console.log(`      - ${c}`));
        }
        if (crossField.length > 0) {
            console.log(`   ⚠️  Cross-Field Issues: ${crossField.length}`);
            crossField.forEach(c => console.log(`      - ${c}`));
        }
    }
    
    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📁 Source: ${jsonPath}`);
    console.log(`${'='.repeat(60)}\n`);
}

await main().catch(err => {
    console.error("❌ Report generation failed:", err);
    console.error(err.stack);
    process.exit(1);
});