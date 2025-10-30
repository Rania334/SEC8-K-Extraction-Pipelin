# SEC 8-K Extraction Pipeline

A production-grade pipeline for ingesting, processing, and extracting structured data from SEC 8-K filings with full evidence provenance and validation.

# SEC 8-K Extraction Pipeline

> ⚠️ **Live Website:** The pipeline is deployed and accessible at [Backend](https://sec8-k-backend.onrender.com) and [Frontend](https://sec8-k-extraction-pipelin.onrender.com).  
> Please note that due to Render's free-tier server limitations, performance may be slower than local runs, and the results may not be as accurate as running the pipeline locally.
> 
<img width="1920" height="2392" alt="frontend (5)" src="https://github.com/user-attachments/assets/15059b31-780e-4fa6-9699-0af0d2af4f2e" />

## Overview

This system transforms SEC 8-K filings (HTML + exhibits) into validated JSON that conforms to a strict schema, with evidence links for every extracted field. It supports both rule-based and AI-powered extraction methods.

## Features

- **Multi-stage Pipeline**: Ingest → Chunk → Extract → Validate → Report
- **Evidence Provenance**: Every non-null field links back to source document snippets
- **Flexible Extraction**: Rule-based (manual), Cloud AI (Gemini), or Local LLM (Ollama)
- **Schema Validation**: AJV-based validation with custom evidence checking
- **RESTful API**: Express server for programmatic access
- **OCR Support**: Optional OCR for image-based exhibits
- **Deterministic Chunking**: Same input → same chunks
- **Retry Logic**: Exponential backoff for network requests
- **Idempotency**: Safe re-runs with caching

## Architecture

```
SEC 8-K URL
    ↓
[INGEST] - Download HTML + exhibits → manifest.json
    ↓
[CHUNK] - Parse HTML → clean text → overlapping chunks
    ↓
[EXTRACT] - Apply rules/AI → structured JSON with evidence
    ↓
[VALIDATE] - Schema + evidence verification
    ↓
[REPORT] - Coverage & quality metrics
```

## Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn
- (Optional) Ollama for local LLM
- (Optional) Tesseract for OCR

### Installation

```bash
npm install
```


### Basic Usage

#### CLI Mode

```bash
# 1. Ingest a filing
ingest https://www.sec.gov/Archives/edgar/data/1178670/000119312523194715/d448801d8k.htm --out data/

# 2. Chunk the document
chunk.js 1178670-000119312523194715 --target 3000 --overlap 200
chunk.js 1178670-000119312523194715 --target 3000 --overlap 200 --ocr

# 3. Extract (rule-based)
extract 1178670-000119312523194715 --schema schemas/demo-schema-v1.json --mode ai
extract 1178670-000119312523194715 --schema schemas/demo-schema-v1.json --mode manual
extract 1178670-000119312523194715 --schema schemas/demo-schema-v1.json --mode local

# 4. Validate
validate data/extracted/1178670-000119312523194715.json --schema schemas/gold-schema-v1.json

# 5. Generate report
report 1178670-000119312523194715
```

#### API Mode

```bash
# Start server
npm start

# Run full pipeline
curl -X POST http://localhost:3001/api/process \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.sec.gov/Archives/edgar/data/1178670/000119312523194715/d448801d8k.htm"}'
```

## Test Cases

The pipeline has been validated on these filings:

### 1. ALNY × Roche (Collaboration)
```bash
URL: https://www.sec.gov/Archives/edgar/data/1178670/000119312523194715/d448801d8k.htm
Type: Partnership/Collaboration
Features: Upfront payment, milestones, press release exhibit
```

### 2. BIIB × Reata (Merger)
```bash
URL: https://www.sec.gov/Archives/edgar/data/875045/000119312523198542/d454539d8k.htm
Type: Merger & Acquisition
Features: Multiple material agreements, purchase price
```

## Extraction Modes

### Manual (Rule-based)
- Pattern matching & heuristics
- No API costs
- Fast & deterministic
- Best for standard filings

```bash
./extract.js <doc_id> --mode manual --schema schemas/gold-schema-v1.json
```

### Cloud AI (Gemini)
- Uses Google Gemini 2.0 Flash
- Better accuracy on complex filings
- Requires API key
- Supports mock mode for testing

```bash
./extract.js <doc_id> --mode ai --schema schemas/gold-schema-v1.json
```

### Local LLM (Ollama)
- Runs locally
- Supports Llama, Mistral, etc.
- No API costs
- Requires Ollama installation

```bash
./extract.js <doc_id> --mode local --schema schemas/gold-schema-v1.json --llm-model llama3.2
```



## API Endpoints

### Health Check
```
GET /api/health
```

### Full Pipeline
```
POST /api/process
Body: { "url": "...", "useAI": false, "mock": false }
```

### Individual Steps
```
POST /api/ingest       - Download filing
POST /api/chunk        - Process text
POST /api/extract      - Extract (manual)
POST /api/extract-ai   - Extract (AI)
POST /api/validate     - Validate output
```

### Data Access
```
GET  /api/report/:docId           - Get metrics
GET  /api/download/:docId?ai=true - Download JSON
GET  /api/extractions             - List all extractions
```

## Advanced Features

### OCR Support
```bash
chunk.js <doc_id> --ocr --ocr-lang eng
```

### Custom LLM Endpoint
```bash
extract.js <doc_id> --mode local \
  --llm-url http://localhost:11434/api/generate \
  --llm-model mistral \
  --llm-temperature 0.1 \
  --llm-max-tokens 8192
```

### Retry Configuration
```bash
extract.js <doc_id> --mode ai \
  --max-retries 5 \
  --timeout 180000
```

## Testing

```bash
# Run integration tests
npm test

# Test specific filing
npm test -- --testNamePattern="ALNY"
```

## Validation Rules

### Hard Constraints
- Accession format: `\d{10}-\d{2}-\d{6}`
- All dates in ISO format (YYYY-MM-DD)
- Monetary values must be positive integers
- SHA256 hashes must be 64 hex characters
- Company names cannot be sentence fragments

### Cross-Field Checks
- `effectiveDate` ≤ `filedDate`
- Collaboration events must mention Item 1.01
- Total value should match sum of upfront + milestones

### Evidence Requirements
- Every non-null field must have ≥1 evidence object
- Evidence snippets must exist in referenced chunks
- Snippets must be verbatim quotes (10-50 words)

## Performance

- **Ingestion**: ~5-15s per filing (depends on exhibit count)
- **Chunking**: ~1-2s per filing
- **Manual Extraction**: ~2-5s per filing
- **AI Extraction**: ~30-60s per filing (API latency)
- **Local LLM**: ~60-120s per filing (model dependent)
- **Validation**: <1s per filing

## Error Handling

All components implement:
- Exponential backoff for network requests
- Graceful degradation (missing exhibits logged, not fatal)
- Detailed error messages with context
- Idempotency keys for API calls
- Timeout protection
