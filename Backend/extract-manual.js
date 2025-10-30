#!/usr/bin/env node
import fs from "fs-extra";
import path from "path";
import { Command } from "commander";

const program = new Command();

program
    .argument("<doc_id>", "Document ID")
    .requiredOption("--schema <path>", "Path to JSON schema")
    .option("--out <dir>", "Output dir", "data/extracted")
    .parse(process.argv);

const [docId] = program.args;
const opts = program.opts();

const RAW_DIR = path.join("data", "raw", docId);
const CHUNK_DIR = path.join("data", "chunks", docId);
const OUT_DIR = path.resolve(opts.out);
await fs.ensureDir(OUT_DIR);

/* ---------- helpers ---------- */

function loadChunks(chunkDir) {
    if (!fs.existsSync(chunkDir)) return [];
    const files = fs.readdirSync(chunkDir)
        .filter(f => f.endsWith(".txt") && f.startsWith("chunk_"))
        .sort();
    return files.map(f => ({
        file: f,
        text: fs.readFileSync(path.join(chunkDir, f), "utf8")
    }));
}

function formatAccession(acc) {
    if (!acc) return null;
    if (/^\d{10}-\d{2}-\d{6}$/.test(acc)) return acc;
    const digits = acc.replace(/\D/g, "");
    if (digits.length === 18) {
        return `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12, 18)}`;
    }
    return null;
}

function parseDateToISO(text) {
    if (!text) return null;
    text = text.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    
    const patterns = [
        /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i,
        /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)[a-z]*,?\s+(\d{4})\b/i,
        /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/
    ];
    
    for (const p of patterns) {
        const m = text.match(p);
        if (m) {
            try {
                if (p === patterns[2]) {
                    const dt = new Date(`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`);
                    if (!isNaN(dt)) return dt.toISOString().slice(0,10);
                } else if (p === patterns[1]) {
                    const dt = new Date(`${m[2]} ${m[1]}, ${m[3]}`);
                    if (!isNaN(dt)) return dt.toISOString().slice(0,10);
                } else {
                    const dt = new Date(`${m[1]} ${m[2]}, ${m[3]}`);
                    if (!isNaN(dt)) return dt.toISOString().slice(0,10);
                }
            } catch(e) { /* ignore */ }
        }
    }
    
    const dt = new Date(text);
    if (!isNaN(dt)) return dt.toISOString().slice(0,10);
    return null;
}

function parseMoneyToUSD(text) {
    if (!text) return null;
    const cleaned = text.replace(/[()]/g, "").replace(/[,]/g, "").trim();
    const m = cleaned.match(/(?:\$|USD\s*)?\s*([0-9]+(?:\.[0-9]+)?)(?:\s*(thousand|million|billion))?/i);
    if (!m) return null;
    let num = parseFloat(m[1]);
    const scale = (m[2] || "").toLowerCase();
    if (scale === "thousand") num *= 1e3;
    else if (scale === "million") num *= 1e6;
    else if (scale === "billion") num *= 1e9;
    return Math.round(num);
}

function escapeForRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findEvidence(searchText, chunks, manifest) {
    if (!searchText) {
        const first = chunks[0];
        return {
            sourceFile: first?.file || "unknown",
            sourceUrl: manifest.primary_url,
            sourceSection: "",
            selector: `chunk:${first?.file || "unknown"}`,
            snippet: (first?.text || "").slice(0,200)
        };
    }

    const norm = String(searchText).trim();
    if (/\b(provisions|warranties|obligations|not applicable|unknown)\b/i.test(norm) && norm.split(/\s+/).length > 8) {
        return {
            sourceFile: chunks[0]?.file || "unknown",
            sourceUrl: manifest.primary_url,
            sourceSection: "",
            selector: `chunk:${chunks[0]?.file || "unknown"}`,
            snippet: "Invalid search text - no evidence found"
        };
    }

    const safe = escapeForRegex(norm);
    const re = new RegExp(safe.replace(/\s+/g, "\\s+"), "i");

    for (const chunk of chunks) {
        const m = chunk.text.match(re);
        if (m) {
            const idx = m.index;
            const snippetStart = Math.max(0, idx - 80);
            const snippetEnd = Math.min(chunk.text.length, idx + (m[0]?.length || norm.length) + 80);
            const beforeSection = chunk.text.slice(0, idx);
            const sectionMatch = beforeSection.match(/===\s*Item\s+[\d.]+[^=]*===/gi);
            const section = sectionMatch ? sectionMatch[sectionMatch.length - 1].trim() : "";
            return {
                sourceFile: chunk.file,
                sourceUrl: manifest.primary_url,
                sourceSection: section,
                selector: `chunk:${chunk.file}`,
                snippet: chunk.text.slice(snippetStart, snippetEnd).trim().slice(0,200)
            };
        }
    }

    const words = norm.split(/\s+/).filter(w => w.length>3);
    for (const chunk of chunks) {
        const lower = chunk.text.toLowerCase();
        let hits = 0;
        for (const w of words.slice(0,6)) {
            if (lower.includes(w.toLowerCase())) hits++;
        }
        if (hits >= Math.min(2, Math.max(1, Math.floor(words.length/2)))) {
            const idx = Math.max(0, lower.indexOf(words.find(w => lower.includes(w.toLowerCase())) || words[0].toLowerCase()));
            const snippetStart = Math.max(0, idx - 80);
            const snippetEnd = Math.min(chunk.text.length, idx + 200);
            const sectionMatch = chunk.text.slice(0, idx).match(/===\s*Item\s+[\d.]+[^=]*===/gi);
            const section = sectionMatch ? sectionMatch[sectionMatch.length - 1].trim() : "";
            return {
                sourceFile: chunk.file,
                sourceUrl: manifest.primary_url,
                sourceSection: section,
                selector: `chunk:${chunk.file}`,
                snippet: chunk.text.slice(snippetStart, snippetEnd).trim().slice(0,200)
            };
        }
    }

    const first = chunks[0];
    return {
        sourceFile: first?.file || "unknown",
        sourceUrl: manifest.primary_url,
        sourceSection: "",
        selector: `chunk:${first?.file || "unknown"}`,
        snippet: (first?.text || "").slice(0,200)
    };
}

function extractCompanyName(text, manifest) {
    if (!text) return manifest?.company_name || null;
    
    // Strategy 1: Look in Item 1.01 section
    const item101Pattern = /Item\s+1\.01[\s\S]{0,800}?([A-Z][A-Za-z0-9\s,&.'\-]{3,80}?(?:Inc\.?|Corporation|Corp\.?|Ltd\.?|LLC|Pharmaceuticals|Holdings|Technologies|Systems|Group|PLC|AG|GmbH))[\s,]+\([""''""]?the\s+[""''""]?(?:Company|Registrant)[""''""]?\)/i;
    const item101Match = text.match(item101Pattern);
    
    if (item101Match) {
        const candidate = item101Match[1].trim().replace(/[,\s]+$/, '');
        console.log(`  Strategy 1 (Item 1.01): Found "${candidate}"`);
        if (!/\b(State|jurisdiction|incorporation|provisions|warranties|Commission|File|Number)\b/i.test(candidate) &&
            candidate.split(/\s+/).length <= 8) {
            return candidate;
        }
    }
    
    // Strategy 2: Look before Item 1.01
    const beforeItem = text.match(/([A-Z][A-Za-z0-9\s,&.'\-]{5,80}?(?:Inc\.?|Corporation|Corp\.?|Ltd\.?|LLC|Pharmaceuticals|Holdings|Technologies|Systems|Group|PLC|AG|GmbH))[\s\S]{0,500}?===\s*Item\s+1\.01/i);
    if (beforeItem) {
        const candidate = beforeItem[1].trim().replace(/[,\s]+$/, '');
        console.log(`  Strategy 2 (before Item 1.01): Found "${candidate}"`);
        if (!/\b(State|jurisdiction|incorporation|Commission|File|Trading|Symbol)\b/i.test(candidate) &&
            candidate.split(/\s+/).length <= 8) {
            return candidate;
        }
    }
    
    // Strategy 3: Use manifest
    if (manifest?.company_name && 
        manifest.company_name !== "Not applicable" &&
        manifest.company_name.length > 3 &&
        !/\b(jurisdiction|incorporation|State)\b/i.test(manifest.company_name)) {
        console.log(`  Strategy 3 (manifest): Found "${manifest.company_name}"`);
        return manifest.company_name;
    }
    
    // Strategy 4: Look for "Exact name" section
    const exactNameSection = text.match(/Date of report[^\n]*\n\s*([A-Z][A-Za-z0-9\s,&.'\-]{5,80}?(?:Inc\.?|Corporation|Corp\.?|Ltd\.?|LLC|Pharmaceuticals|Holdings|Technologies|Systems|Group|PLC|AG|GmbH)\.?)\s*\n\s*\(Exact\s+name/i);
    if (exactNameSection) {
        const candidate = exactNameSection[1].trim();
        console.log(`  Strategy 4 (Exact name): Found "${candidate}"`);
        if (!/\b(State|jurisdiction|incorporation|Commission)\b/i.test(candidate) &&
            candidate.split(/\s+/).length <= 8) {
            return candidate;
        }
    }
    
    // Strategy 5: Look in header section
    const headerSection = text.match(/FORM\s+8-K[\s\S]{0,2000}?(?:\(Exact\s+name|Item\s+1\.01)/i);
    if (headerSection) {
        const lines = headerSection[0].split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (/(?:Inc\.?|Corporation|Corp\.?|Ltd\.?|LLC|Pharmaceuticals|Holdings|Technologies|Systems|Group|PLC|AG|GmbH)\.?\s*$/i.test(trimmed) &&
                !/^(UNITED STATES|SECURITIES|COMMISSION|WASHINGTON|FORM|CURRENT REPORT|Date of|State|Commission|File|Number|Exact name|incorporation|jurisdiction|Trading|Symbol|Title|Name of|Address|Registrant|telephone)/i.test(trimmed) &&
                !trimmed.includes('\t') &&
                trimmed.length >= 5 && trimmed.length <= 100 &&
                trimmed.split(/\s+/).length <= 8 &&
                /^[A-Z]/.test(trimmed)) {
                console.log(`  Strategy 5 (header line): Found "${trimmed}"`);
                return trimmed;
            }
        }
    }
    
    console.log(`  ⚠️  No company name found`);
    return null;
}

function detectEventKind(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    if (/\b(collaboration agreement|license agreement|strategic collaboration|collaborat)/i.test(t)) return "Collaboration";
    if (/\b(merger|acquisition|acquired|acquires|purchase agreement|merger agreement)\b/i.test(t)) return "Merger";
    if (/\b(partnership|partner|strategic alliance)\b/i.test(t)) return "Partnership";
    if (/\b(financing|loan|equity financing|underwritten offering|investment)\b/i.test(t)) return "Financing";
    return null;
}

/* ---------- main run ---------- */

async function run() {
    const manifestPath = path.join(RAW_DIR, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
        console.error("❌ manifest.json not found in", RAW_DIR);
        process.exit(1);
    }

    const manifest = await fs.readJson(manifestPath);
    const chunks = loadChunks(CHUNK_DIR);
    const fullText = chunks.map(c => c.text).join("\n\n");

    console.log(`\n📄 Extracting from ${docId}...`);
    console.log(`  Total text length: ${fullText.length} chars`);
    console.log(`  Chunks: ${chunks.length}`);

    console.log(`\n🔍 Extracting company name...`);
    const doc = {
        accession: manifest.accession_guess || formatAccession(manifest.accession_raw),
        filingType: manifest.filing_type || "8-K",
        filedDate: null,  // Will extract below
        companyName: extractCompanyName(fullText, manifest),
        cik: manifest.primary_url?.match(/data\/(\d+)\//)?.[1] || null
    };

    // FIXED: Extract filed date more carefully
    console.log(`\n📅 Extracting filed date...`);
    // The filing date is when the document was filed with SEC (July 26, 2023)
    const reportDateMatch = fullText.match(/Date of report[^:()]*:\s*([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i);
    if (reportDateMatch) {
        doc.filedDate = parseDateToISO(reportDateMatch[1]);
        console.log(`  Report date found: ${reportDateMatch[1]} → ${doc.filedDate}`);
    } else if (manifest.filed_date) {
        doc.filedDate = parseDateToISO(manifest.filed_date);
        console.log(`  Using manifest date: ${manifest.filed_date} → ${doc.filedDate}`);
    }

    const itemMatch = fullText.match(/===\s*Item\s+([\d.]+)/i);
    const itemIndex = itemMatch?.index || 0;

    const contextWindow = fullText.slice(
        Math.max(0, itemIndex - 1000),
        Math.min(fullText.length, itemIndex + 8000)
    );

    const event = {
        kind: detectEventKind(contextWindow),
        secItem: itemMatch ? `Item ${itemMatch[1]}` : null,
        headline: null,
        summary: null,
        totalValueUSD: null,
        effectiveDate: null
    };

    // Extract headline
    const headlinePatterns = [
        /===\s*Item\s+[\d.]+\s*===\s*\n\s*([^\n]{10,200})/i,
        /^(?:PRESS RELEASE:|Press Release:)\s*([^\n]{10,200})/i,
        /Item\s+[\d.]+\s+([A-Z][^\n]{10,150}\.)/i
    ];
    for (const p of headlinePatterns) {
        const m = contextWindow.match(p);
        if (m) {
            event.headline = (m[1] || m[0]).trim();
            break;
        }
    }

    // Extract summary - look for complete sentences
    const summaryPatterns = [
        // Pattern 1: Full sentence about entering into agreement
        /(?:On [A-Z][a-z]+ \d{1,2}, \d{4}[^,]*,\s*)?[^.]*entered into\s+a\s+(?:strategic\s+)?(?:Collaboration and License Agreement|collaboration|license agreement)[^.]{0,500}\./i,
        // Pattern 2: Announced pattern
        /(?:announced|has entered into|has entered a)[^.]{0,300}\./i
    ];
    for (const p of summaryPatterns) {
        const m = contextWindow.match(p);
        if (m) {
            event.summary = m[0].trim();
            console.log(`  Summary: ${event.summary.slice(0, 100)}...`);
            break;
        }
    }

    // FIXED: Extract effective date (prioritize earliest event date)
    console.log(`\n📅 Extracting effective date...`);
    const datePatterns = [
        // Priority 1: Earliest event date in parentheses - look for the date INSIDE the parentheses
        /Date of earliest event reported[^\n]*\(\s*([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s*\)/i,
        // Priority 2: "On [Date] (the ""), Company..." - the actual agreement date
        /\bOn\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s+\([^)]*\)/i,
        // Priority 3: Standard patterns
        /(?:effective|dated|entered into)\s+(?:as of\s+)?([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i,
        /\bdate[^\n]{0,50}([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i,
        /\b(effective\s+as\s+of)\s+(\d{1,2}\/\d{1,2}\/\d{4})/i
    ];
    for (const p of datePatterns) {
        const m = fullText.match(p);  // Search full text for earliest event
        if (m) {
            const candidate = m[1] || m[2];
            const iso = parseDateToISO(candidate);
            if (iso) {
                event.effectiveDate = iso;
                console.log(`  Found effective date: ${candidate} → ${iso}`);
                break;
            }
        }
    }

    // Extract monetary values
    const moneyMatches = Array.from(contextWindow.matchAll(/(?:\$|USD\s*)\s*[0-9,]+(?:\.[0-9]+)?\s*(?:million|billion|thousand)?/gi));
    const plainNumberMatches = Array.from(contextWindow.matchAll(/\$?\s*[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?/g));
    const amounts = [];
    for (const m of moneyMatches) {
        const val = parseMoneyToUSD(m[0]);
        if (val) amounts.push({ raw: m[0], usd: val });
    }
    for (const m of plainNumberMatches) {
        const val = parseMoneyToUSD(m[0]);
        if (val) amounts.push({ raw: m[0], usd: val });
    }
    if (amounts.length > 0) {
        amounts.sort((a,b)=>b.usd-a.usd);
        event.totalValueUSD = amounts[0].usd;
    }

    const isPartnership = /\b(collaboration|collaborat|license agreement|strategic collaboration|partnership|partner)\b/i.test(contextWindow);
    const isDeal = /\b(merger|acquisition|acquired|acquires|purchase agreement|purchase of)\b/i.test(contextWindow);

    let partnership = null;
    let deal = null;

    let partnerAText = null;
    let partnerBText = null;
    let scopeText = null;
    let territoryText = null;
    let upfrontText = null;
    let milestoneText = null;

    console.log(`\n🤝 Looking for partnerships...`);
    if (isPartnership) {
        partnership = {};
        
        if (doc.companyName) {
            partnership.partnerA = doc.companyName;
            partnerAText = doc.companyName;
            console.log(`  Partner A: ${partnership.partnerA}`);
        }
        
        // FIXED: Look for full Roche name first - try multiple patterns
        const rochePatterns = [
            /\bwith\s+(F\.\s*Hoffmann-La\s*Roche\s*Ltd\.?)/i,
            /\b(F\.\s*Hoffmann-La\s*Roche\s*Ltd\.?)/i,
            // Also accept if just "Roche Ltd" or "F. Roche Ltd" appears but try to get full name
            /\bwith\s+F\.\s*Roche\s+Ltd/i
        ];
        
        for (const pattern of rochePatterns) {
            const rocheMatch = contextWindow.match(pattern);
            if (rocheMatch) {
                // If we got the full name, use it
                if (rocheMatch[1] && rocheMatch[1].includes('Hoffmann')) {
                    partnership.partnerB = rocheMatch[1].trim();
                    partnerBText = rocheMatch[1].trim();
                    console.log(`  Partner B (Roche full name): ${partnership.partnerB}`);
                    break;
                } else if (rocheMatch[0].includes('F. Roche Ltd')) {
                    // If we only got "F. Roche Ltd", try to find the full name elsewhere
                    const fullRocheMatch = fullText.match(/F\.\s*Hoffmann-La\s*Roche\s*Ltd\.?/i);
                    if (fullRocheMatch) {
                        partnership.partnerB = fullRocheMatch[0].trim();
                        partnerBText = fullRocheMatch[0].trim();
                        console.log(`  Partner B (Roche from full text): ${partnership.partnerB}`);
                    } else {
                        partnership.partnerB = "F. Hoffmann-La Roche Ltd.";
                        partnerBText = "F. Roche Ltd";  // For evidence matching
                        console.log(`  Partner B (Roche normalized): ${partnership.partnerB}`);
                    }
                    break;
                }
            }
        }
        
        // Fallback to generic partner pattern
        if (!partnership.partnerB) {
            const withPartnerPattern = /\bwith\s+([A-Z][A-Za-z0-9\s.,'\-]{3,80}?(?:Inc\.?|Corporation|Corp\.?|Ltd\.?|LLC|AG|PLC|GmbH|Pharmaceuticals|Holdings)\.?)/i;
            const withMatch = contextWindow.match(withPartnerPattern);
            
            if (withMatch) {
                const partner = withMatch[1].trim().replace(/[,.]$/, '');
                if (partner.split(/\s+/).length <= 10 && 
                    !/\b(Agreement|provisions|warranties|obligations|representations|confidentiality|contains|among)\b/i.test(partner)) {
                    partnership.partnerB = partner;
                    partnerBText = partner;
                    console.log(`  Partner B (with pattern): ${partnership.partnerB}`);
                }
            }
        }
        
        // Between pattern
        if (!partnership.partnerB) {
            const betweenPattern = /between\s+(?:the\s+)?([A-Z][A-Za-z0-9\s.,'\-]{3,80}?(?:Inc\.?|Corp\.?|Ltd\.?|LLC|AG|PLC)\.?)\s+and\s+([A-Z][A-Za-z0-9\s.,'\-]{3,80}?(?:Inc\.?|Corp\.?|Ltd\.?|LLC|AG|PLC)\.?)/i;
            const betweenMatch = contextWindow.match(betweenPattern);
            
            if (betweenMatch) {
                const p1 = betweenMatch[1].trim().replace(/[,.]$/, '');
                const p2 = betweenMatch[2].trim().replace(/[,.]$/, '');
                
                if (!partnership.partnerA && p1.split(/\s+/).length <= 10) {
                    partnership.partnerA = p1;
                    partnerAText = p1;
                }
                if (p2.split(/\s+/).length <= 10) {
                    partnership.partnerB = p2;
                    partnerBText = p2;
                    console.log(`  Partner B (between pattern): ${partnership.partnerB}`);
                }
            }
        }
        
        // Known pharma companies pattern
        if (!partnership.partnerB) {
            const pharmaPattern = /\b(F\.\s*Hoffmann-La\s*Roche\s*Ltd\.?|Roche|Genentech,?\s*Inc\.?|Novartis|Pfizer|Merck|Sanofi|Bristol-Myers\s+Squibb|Johnson\s*&\s*Johnson|AstraZeneca|GlaxoSmithKline|Eli\s+Lilly)(?:\s+(?:Ltd\.|Inc\.|AG|PLC|Corp\.?))?\b/gi;
            const pharmaMatches = Array.from(contextWindow.matchAll(pharmaPattern));
            
            if (pharmaMatches.length > 0) {
                for (const match of pharmaMatches) {
                    const pharma = match[0].trim().replace(/,$/, '');
                    if (!partnership.partnerA || !partnership.partnerA.toLowerCase().includes(pharma.toLowerCase())) {
                        partnership.partnerB = pharma;
                        partnerBText = pharma;
                        console.log(`  Partner B (known pharma): ${partnership.partnerB}`);
                        break;
                    }
                }
            }
        }

        // FIXED: Extract scope with better truncation handling
        const scopePatterns = [
            /(?:collaboration for)[^.]{0,300}(?:containing|targeting)\s+([^.]{10,200})/i,
            /(?:develop|development|commercialization)[^.]{0,300}(?:containing|targeting|for|of)\s+([^.]{10,200})/i,
        ];
        
        for (const p of scopePatterns) {
            const scopeMatch = contextWindow.match(p);
            if (scopeMatch) {
                scopeText = scopeMatch[0].trim();
                // If it ends mid-word or looks truncated, try to extend to sentence end
                if (!/[.!?]$/.test(scopeText)) {
                    const extended = contextWindow.slice(contextWindow.indexOf(scopeText));
                    const sentenceEnd = extended.search(/[.!?]\s/);
                    if (sentenceEnd > 0 && sentenceEnd < 250) {
                        scopeText = extended.slice(0, sentenceEnd + 1).trim();
                    }
                }
                partnership.scope = scopeText;
                console.log(`  Scope: ${scopeText.slice(0, 100)}...`);
                break;
            }
        }

        // Extract territory
        const territoryMatch = contextWindow.match(/\b(worldwide|globally|global|United States|U\.S\.|outside the U\.S\.)\b/i);
        if (territoryMatch) {
            territoryText = territoryMatch[0];
            partnership.territory = territoryText;
        }

        // Extract upfront payment
        const upfrontMatch = contextWindow.match(/upfront\s+(?:cash\s+)?payment\s+(?:of\s+)?(\$[0-9,]+(?:\.[0-9]+)?(?:\s*(?:million|billion|thousand))?)/i);
        if (upfrontMatch) {
            upfrontText = upfrontMatch[1];
            partnership.upfrontPaymentUSD = parseMoneyToUSD(upfrontText);
        }

        // Extract milestone payments
        const milestonePatterns = [
            /(?:up to|total of|potentially)\s+(\$[0-9,]+(?:\.[0-9]+)?(?:\s*(?:billion|million))?)/i,
            /milestone\s+payments?\s+(?:of|up to)\s+(\$[0-9,]+(?:\.[0-9]+)?(?:\s*(?:million|billion))?)/i
        ];
        for (const p of milestonePatterns) {
            const m = contextWindow.match(p);
            if (m) {
                const amt = parseMoneyToUSD(m[1]);
                if (amt && amt > (partnership.upfrontPaymentUSD || 0)) {
                    milestoneText = m[1];
                    partnership.milestonesUSD = amt;
                    break;
                }
            }
        }
        
        if (!partnership.partnerA || !partnership.partnerB) {
            console.log(`  ⚠️  Incomplete partnership data - discarding`);
            partnership = null;
        }
    } else if (isDeal) {
        deal = {};
        const targetMatch = contextWindow.match(/(?:acquisition of|acquired|purchase of)\s+([A-Z][A-Za-z0-9\s.,'&-]{2,120}?)(?:\s|,|\.)/i);
        if (targetMatch) {
            deal.target = targetMatch[1].trim().replace(/[,.]$/,'');
        }
        const buyerMatch = contextWindow.match(/(?:buyer|purchaser|acquirer)\s*:\s*([A-Z][A-Za-z0-9\s.,'&-]+)/i);
        const sellerMatch = contextWindow.match(/(?:seller|target|seller)\s*:\s*([A-Z][A-Za-z0-9\s.,'&-]+)/i);
        if (buyerMatch) deal.buyer = buyerMatch[1].trim();
        if (sellerMatch) deal.seller = sellerMatch[1].trim();
    }

    const provDocs = (manifest.files || []).map(f => {
        const filename = path.basename(f.path || f.filename || "");
        const isExhibit = /ex\d|dex\d/i.test(filename);
        return {
            role: isExhibit ? "exhibit" : "primary",
            filename,
            sourceUrl: f.sourceUrl || manifest.primary_url,
            sha256: f.sha256 || f.sha || ""
        };
    });

    const evidence = [];

    function addEvidence(field, searchValue) {
        if (searchValue === null || searchValue === undefined || searchValue === "") return;
        const ev = findEvidence(String(searchValue), chunks, manifest);
        ev.field = field;
        evidence.push(ev);
    }

    addEvidence("doc.accession", doc.accession || manifest.accession);
    addEvidence("doc.filingType", doc.filingType);
    addEvidence("doc.filedDate", manifest.filed_date || doc.filedDate);
    if (doc.companyName) addEvidence("doc.companyName", doc.companyName);
    addEvidence("doc.cik", doc.cik);

    addEvidence("event.kind", event.kind || "");
    addEvidence("event.secItem", event.secItem);
    addEvidence("event.headline", event.headline);
    addEvidence("event.summary", event.summary);
    if (event.totalValueUSD) {
        const maxRaw = amounts.length ? amounts[0].raw : null;
        addEvidence("event.totalValueUSD", maxRaw || `${event.totalValueUSD}`);
    }
    addEvidence("event.effectiveDate", event.effectiveDate || "");

    if (partnership) {
        if (partnerAText) addEvidence("partnership.partnerA", partnerAText);
        if (partnerBText) addEvidence("partnership.partnerB", partnerBText);
        if (scopeText) addEvidence("partnership.scope", scopeText);
        if (territoryText) addEvidence("partnership.territory", territoryText);
        if (upfrontText) addEvidence("partnership.upfrontPaymentUSD", upfrontText);
        if (milestoneText) addEvidence("partnership.milestonesUSD", milestoneText);
    }
    if (deal) {
        if (deal.target) addEvidence("deal.target", deal.target);
        if (deal.buyer) addEvidence("deal.buyer", deal.buyer);
        if (deal.seller) addEvidence("deal.seller", deal.seller);
    }

    for (const pd of provDocs) {
        const snippetSource = chunks.find(c => c.file === pd.filename) || chunks[0];
        evidence.push({
            field: "provenance.documents",
            sourceFile: snippetSource?.file || pd.filename || "unknown",
            sourceUrl: pd.sourceUrl || manifest.primary_url,
            sourceSection: "",
            selector: `chunk:${snippetSource?.file || "unknown"}`,
            snippet: (snippetSource?.text || "").slice(0,200)
        });
    }

    const hardConstraints = [];
    const crossField = [];

    // Validation: Hard constraints
    if (!doc.accession || !/^\d{10}-\d{2}-\d{6}$/.test(doc.accession)) {
        hardConstraints.push("Invalid accession format");
    }
    if (!doc.filedDate) hardConstraints.push("Missing filed date");
    if (!event.secItem) hardConstraints.push("Missing SEC Item number");
    if (!doc.companyName || doc.companyName === "Not applicable") {
        hardConstraints.push("Missing or invalid company name");
    }

    for (const pd of provDocs) {
        if (!pd.sha256 || pd.sha256.length !== 64) {
            hardConstraints.push(`provenance.sha256 invalid for ${pd.filename}`);
        }
    }

    if (partnership) {
        if (partnership.partnerA && 
            (/\b(provisions|warranties|obligations|agreement|contains)\b/i.test(partnership.partnerA) ||
             partnership.partnerA.split(/\s+/).length > 10)) {
            hardConstraints.push("Invalid partnerA - appears to be sentence fragment");
        }
        if (partnership.partnerB && 
            (/\b(provisions|warranties|obligations|agreement|contains)\b/i.test(partnership.partnerB) ||
             partnership.partnerB.split(/\s+/).length > 10)) {
            hardConstraints.push("Invalid partnerB - appears to be sentence fragment");
        }
    }

    // Validation: Cross-field checks
    if (event.totalValueUSD !== null && event.totalValueUSD <= 0) {
        crossField.push("event.totalValueUSD is non-positive");
    }
    if (event.kind === "Collaboration") {
        if (!/Item\s+1\.01/i.test(fullText) && !/agreement/i.test(contextWindow)) {
            crossField.push("Collaboration found but no Item 1.01/agreement mention detected");
        }
    }
    
    // Validate that effectiveDate is before filedDate
    if (event.effectiveDate && doc.filedDate) {
        const effDate = new Date(event.effectiveDate);
        const filedDate = new Date(doc.filedDate);
        if (effDate > filedDate) {
            crossField.push("event.effectiveDate is after doc.filedDate (should be earlier or same)");
        }
    }

    const output = {
        doc,
        event,
        provenance: { documents: provDocs },
        evidence,
        validation: { hardConstraints, crossField }
    };

    if (partnership) output.partnership = partnership;
    if (deal) output.deal = deal;

    const outPath = path.join(OUT_DIR, `${docId}.json`);
    await fs.writeJson(outPath, output, { spaces: 2 });

    console.log(`\n✅ Extraction complete`);
    console.log(`   Company: ${doc.companyName || 'NOT FOUND'}`);
    console.log(`   Filed Date: ${doc.filedDate || 'NOT FOUND'}`);
    console.log(`   Event kind: ${event.kind}`);
    console.log(`   SEC Item: ${event.secItem}`);
    console.log(`   Effective Date: ${event.effectiveDate || 'NOT FOUND'}`);
    if (partnership) {
        console.log(`   Partners: ${partnership?.partnerA || '?'} & ${partnership?.partnerB || '?'}`);
        console.log(`   Upfront: ${partnership.upfrontPaymentUSD?.toLocaleString() || '0'}`);
        console.log(`   Milestones: ${partnership.milestonesUSD?.toLocaleString() || '0'}`);
    }
    console.log(`   Total Value: ${event.totalValueUSD?.toLocaleString() || '0'}`);
    console.log(`   Evidence objects: ${evidence.length}`);
    console.log(`   Hard constraints: ${hardConstraints.length}`);
    console.log(`   Cross-field issues: ${crossField.length}`);
    
    if (hardConstraints.length > 0) {
        console.log(`\n⚠️  Hard Constraints:`);
        hardConstraints.forEach(c => console.log(`     - ${c}`));
    }
    if (crossField.length > 0) {
        console.log(`\n⚠️  Cross-field Issues:`);
        crossField.forEach(c => console.log(`     - ${c}`));
    }
    
    console.log(`\n📁 Output: ${outPath}`);
}

await run().catch(err => {
    console.error("❌ Extraction failed:", err);
    console.error(err.stack);
    process.exit(1);
});