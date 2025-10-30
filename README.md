# SEC 8-K Ingest Script

## Options
- `--out <dir>`: Output directory (default: `data/`)
- `--proxy <url>`: HTTPS proxy (ignored if using ScraperAPI)
- `--concurrency <n>`: Max concurrent downloads (default: 4)

## Workflow
1. Parse SEC URL to extract CIK and accession number.
2. Create directories for raw filing and exhibits.
3. Configure HTTP agent (proxy or ScraperAPI).
4. Download primary filing HTML (`primary.html`).
5. Extract filing type and filed date from HTML.
6. Identify exhibit URLs from links or text patterns.
7. Sanitize filenames and ensure unique paths.
8. Download exhibits concurrently with concurrency limit.
9. Compute SHA256 and MD5 hashes for all files.
10. Save manifest JSON containing:
    - `doc_id`
    - `primary_url`
    - `filing_type`
    - `filed_date`
    - `accession_raw` and normalized guess
    - `files` array with filename, URL, hashes, role, error
    - `scraper_api_used` and `proxy_used`
    - `timestamp`

## Features
- Retry downloads up to 3 times with exponential backoff.
- Proxy or ScraperAPI support.
- Concurrent exhibit downloads.
- Caching of downloaded files to prevent duplicates.
- Manifest includes all file metadata and download status.
