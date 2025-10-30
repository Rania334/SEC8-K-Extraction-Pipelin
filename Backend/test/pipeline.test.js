import { jest } from '@jest/globals';
import request from 'supertest';
import fs from 'fs-extra';
import path from 'path';
import app from '../server.js';

jest.setTimeout(600000);

const TEST_URL = 'https://www.sec.gov/Archives/edgar/data/1178670/000119312523194715/d448801d8k.htm';

describe('SEC Extraction Pipeline', () => {
  let docId = '';

  test('1️⃣ Health check works', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('2️⃣ Ingest step works and creates manifest', async () => {
    const res = await request(app)
      .post('/api/ingest')
      .send({ url: TEST_URL });

    expect(res.status).toBe(200);
    expect(res.body.docId).toBeDefined();
    expect(res.body.manifest).toBeDefined();

    docId = res.body.docId;

    const manifestPath = path.join('data', 'raw', docId, 'manifest.json');
    expect(await fs.pathExists(manifestPath)).toBe(true);
  });

  test('3️⃣ Chunk step produces chunk files', async () => {
    const res = await request(app)
      .post('/api/chunk')
      .send({ docId, target: 3000, overlap: 200 });

    expect(res.status).toBe(200);
    expect(res.body.index).toBeDefined();

    const chunksDir = path.join('data', 'chunks', docId);
    const files = await fs.readdir(chunksDir);
    expect(files.some(f => f.startsWith('chunk_'))).toBe(true);
  });

  test('4️⃣ Extraction creates valid JSON', async () => {
    const res = await request(app)
      .post('/api/extract')
      .send({ docId });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();

    const outputPath = path.join('data', 'extracted', `${docId}.json`);
    expect(await fs.pathExists(outputPath)).toBe(true);
  });

  test('5️⃣ Validation passes without fatal errors', async () => {
    const res = await request(app)
      .post('/api/validate')
      .send({ docId });

    expect(res.status).toBe(200);
    expect(res.body.docId).toBe(docId);
  });

  test('6️⃣ Report endpoint returns summary', async () => {
    const res = await request(app).get(`/api/report/${docId}`);
    expect(res.status).toBe(200);
    expect(res.body.report).toBeDefined();
    expect(res.body.report.eventKind).toBeDefined();
  });

  test('7️⃣ Extractions list includes our doc', async () => {
    const res = await request(app).get('/api/extractions');
    expect(res.status).toBe(200);
    expect(res.body.extractions.some(e => e.docId === docId)).toBe(true);
  });
});


