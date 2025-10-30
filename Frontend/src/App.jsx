import React, { useState, useEffect } from 'react';
import { Download, FileText, AlertCircle, CheckCircle, Loader2, ExternalLink, RefreshCw } from 'lucide-react';

const API_BASE = 'https://sec8-k-backend.onrender.com/api';

export default function SECExtractionApp() {
  const [secUrl, setSecUrl] = useState('');
  const [status, setStatus] = useState('idle');
  const [currentStep, setCurrentStep] = useState('');
  const [extractedData, setExtractedData] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [logs, setLogs] = useState([]);
  const [docId, setDocId] = useState(null);
  const [useAI, setUseAI] = useState(false);
  const [recentExtractions, setRecentExtractions] = useState([]);

  useEffect(() => {
    loadRecentExtractions();
  }, []);

  const loadRecentExtractions = async () => {
    try {
      const res = await fetch(`${API_BASE}/extractions`);
      const data = await res.json();
      setRecentExtractions(data.extractions || []);
    } catch (err) {
      console.error('Failed to load recent extractions:', err);
    }
  };

  const handleProcess = async () => {
    if (!secUrl.trim()) {
      setError('Please enter a valid SEC URL');
      return;
    }

    setStatus('processing');
    setError(null);
    setLogs([]);
    setExtractedData(null);
    setReport(null);
    setDocId(null);

    try {
      setCurrentStep('Starting pipeline...');

      const response = await fetch(`${API_BASE}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: secUrl,
          useAI,
          mock: false
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Processing failed');
      }

      setDocId(result.docId);
      setLogs(result.logs || []);
      setExtractedData(result.data);
      setReport(result.report);
      
      if (result.error) {
        setError(result.error);
        setStatus('error');
      } else {
        setStatus('success');
        setCurrentStep('Complete!');
        await loadRecentExtractions();
      }

    } catch (err) {
      setStatus('error');
      setError(err.message);
      setLogs(prev => [...prev, {
        message: `❌ Error: ${err.message}`,
        type: 'error',
        timestamp: new Date().toISOString()
      }]);
    }
  };

  const handleDownload = async () => {
    if (!docId) return;

    try {
      const response = await fetch(`${API_BASE}/download/${docId}?ai=${useAI}`);
      const data = await response.json();
      
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${data.doc?.cik || docId}_${data.doc?.accession || 'extraction'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('Failed to download file: ' + err.message);
    }
  };

  const loadExtraction = async (extraction) => {
    try {
      const response = await fetch(`${API_BASE}/report/${extraction.docId}?ai=${extraction.isAI}`);
      const result = await response.json();
      
      setExtractedData(result.data);
      setReport(result.report);
      setDocId(extraction.docId);
      setUseAI(extraction.isAI);
      setStatus('success');
      setError(null);
      setLogs([{
        message: `✅ Loaded extraction for ${extraction.companyName}`,
        type: 'success',
        timestamp: new Date().toISOString()
      }]);
    } catch (err) {
      setError('Failed to load extraction: ' + err.message);
    }
  };

  const exampleUrls = [
    {
      name: 'ALNY × Roche (Collaboration)',
      url: 'https://www.sec.gov/Archives/edgar/data/1178670/000119312523194715/d448801d8k.htm'
    },
    {
      name: 'BIIB × Reata (Merger)',
      url: 'https://www.sec.gov/Archives/edgar/data/875045/000119312523198542/d454539d8k.htm'
    }
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <FileText className="w-8 h-8 text-blue-600" />
                <h1 className="text-3xl font-bold text-slate-900">SEC 8-K Extraction Pipeline</h1>
              </div>
              <p className="text-slate-600">
                Extract structured data from SEC 8-K filings with evidence-backed JSON output
              </p>
            </div>
            <button
              onClick={loadRecentExtractions}
              className="text-slate-600 hover:text-slate-900 p-2 hover:bg-slate-100 rounded-lg transition"
              title="Refresh"
            >
              <RefreshCw className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column: Input & Logs */}
          <div className="lg:col-span-2 space-y-6">
            {/* Input Section */}
            <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
              <label className="block text-sm font-medium text-slate-700 mb-2">
                SEC Filing URL
              </label>
              <input
                type="text"
                value={secUrl}
                onChange={(e) => setSecUrl(e.target.value)}
                placeholder="https://www.sec.gov/Archives/edgar/data/..."
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition"
                disabled={status === 'processing'}
              />
              
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="text-sm text-slate-600">Examples:</span>
                {exampleUrls.map((example, i) => (
                  <button
                    key={i}
                    onClick={() => setSecUrl(example.url)}
                    className="text-sm text-blue-600 hover:text-blue-700 hover:underline disabled:opacity-50"
                    disabled={status === 'processing'}
                  >
                    {example.name}
                  </button>
                ))}
              </div>

              <div className="mt-4 flex items-center gap-2">
                <input
                  type="checkbox"
                  id="useAI"
                  checked={useAI}
                  onChange={(e) => setUseAI(e.target.checked)}
                  disabled={status === 'processing'}
                  className="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500"
                />
                <label htmlFor="useAI" className="text-sm text-slate-700">
                  Use AI extraction (Gemini)
                </label>
              </div>

              <button
                onClick={handleProcess}
                disabled={status === 'processing' || !secUrl.trim()}
                className="mt-4 w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-medium py-3 px-6 rounded-lg transition flex items-center justify-center gap-2"
              >
                {status === 'processing' ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    {currentStep}
                  </>
                ) : (
                  <>
                    <FileText className="w-5 h-5" />
                    Process Filing
                  </>
                )}
              </button>
            </div>

            {/* Logs */}
            {logs.length > 0 && (
              <div className="bg-slate-900 rounded-lg shadow-sm border border-slate-700 p-4 max-h-96 overflow-y-auto">
                <div className="space-y-1 font-mono text-sm">
                  {logs.map((log, i) => (
                    <div
                      key={i}
                      className={`${
                        log.type === 'error' ? 'text-red-400' :
                        log.type === 'success' ? 'text-green-400' :
                        log.type === 'warning' ? 'text-yellow-400' :
                        'text-slate-300'
                      }`}
                    >
                      {log.message}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-red-900">Error</h3>
                  <p className="text-red-700 text-sm">{error}</p>
                </div>
              </div>
            )}

            {/* Report */}
            {report && (
              <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-bold text-slate-900">Extraction Report</h2>
                  {!report.hasValidationIssues && (
                    <div className="flex items-center gap-2 text-green-600">
                      <CheckCircle className="w-5 h-5" />
                      <span className="font-medium">Validated</span>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-slate-50 rounded-lg p-4">
                    <div className="text-sm text-slate-600 mb-1">Company</div>
                    <div className="text-lg font-semibold text-slate-900">{report.companyName}</div>
                    <div className="text-xs text-slate-500 mt-1">{report.filedDate}</div>
                  </div>

                  <div className="bg-slate-50 rounded-lg p-4">
                    <div className="text-sm text-slate-600 mb-1">Event Type</div>
                    <div className="text-lg font-semibold text-slate-900">{report.eventKind}</div>
                    <div className="text-xs text-slate-500 mt-1">{report.secItem}</div>
                  </div>

                  <div className="bg-slate-50 rounded-lg p-4">
                    <div className="text-sm text-slate-600 mb-1">Total Value</div>
                    <div className="text-lg font-semibold text-slate-900">
                      ${(report.totalValueUSD / 1e9).toFixed(2)}B
                    </div>
                    {report.milestonesUSD > 0 && (
                      <div className="text-xs text-slate-500 mt-1">
                        ${(report.upfrontUSD / 1e6).toFixed(0)}M upfront + ${(report.milestonesUSD / 1e9).toFixed(2)}B milestones
                      </div>
                    )}
                  </div>

                  <div className="bg-slate-50 rounded-lg p-4">
                    <div className="text-sm text-slate-600 mb-1">Documents</div>
                    <div className="text-lg font-semibold text-slate-900">{report.totalDocs}</div>
                    <div className="text-xs text-slate-500 mt-1">{report.exhibitCount} exhibits</div>
                  </div>

                  <div className="bg-slate-50 rounded-lg p-4">
                    <div className="text-sm text-slate-600 mb-1">Evidence Coverage</div>
                    <div className="text-lg font-semibold text-slate-900">{report.coveragePercent}%</div>
                    <div className="text-xs text-slate-500 mt-1">
                      {report.evidenceCount} evidence objects
                    </div>
                  </div>

                  <div className="bg-slate-50 rounded-lg p-4">
                    <div className="text-sm text-slate-600 mb-1">Validation</div>
                    <div className={`text-lg font-semibold ${report.hasValidationIssues ? 'text-yellow-600' : 'text-green-600'}`}>
                      {report.hasValidationIssues ? 'Issues Found' : 'Passed'}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      {report.hardConstraints.length + report.crossFieldIssues.length} issues
                    </div>
                  </div>
                </div>

                {report.hasValidationIssues && (
                  <div className="mt-4 p-4 bg-yellow-50 rounded-lg">
                    <h3 className="font-semibold text-yellow-900 mb-2">Validation Issues</h3>
                    {report.hardConstraints.length > 0 && (
                      <div className="mb-2">
                        <div className="text-sm font-medium text-yellow-800">Hard Constraints:</div>
                        {report.hardConstraints.map((c, i) => (
                          <div key={i} className="text-sm text-yellow-700">• {c}</div>
                        ))}
                      </div>
                    )}
                    {report.crossFieldIssues.length > 0 && (
                      <div>
                        <div className="text-sm font-medium text-yellow-800">Cross-field Issues:</div>
                        {report.crossFieldIssues.map((c, i) => (
                          <div key={i} className="text-sm text-yellow-700">• {c}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <button
                  onClick={handleDownload}
                  className="mt-6 w-full bg-slate-900 hover:bg-slate-800 text-white font-medium py-3 px-6 rounded-lg transition flex items-center justify-center gap-2"
                >
                  <Download className="w-5 h-5" />
                  Download JSON
                </button>
              </div>
            )}

            {/* Preview */}
            {extractedData && (
              <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-bold text-slate-900">Data Preview</h2>
                  <a
                    href={extractedData.provenance?.documents?.[0]?.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1"
                  >
                    View Original <ExternalLink className="w-4 h-4" />
                  </a>
                </div>

                <div className="space-y-4">
                  <div>
                    <h3 className="font-semibold text-slate-900 mb-2">Document Info</h3>
                    <div className="bg-slate-50 rounded p-3 text-sm space-y-1">
                      <div><span className="text-slate-600">Company:</span> <span className="font-medium">{extractedData.doc.companyName}</span></div>
                      <div><span className="text-slate-600">Accession:</span> <span className="font-mono">{extractedData.doc.accession}</span></div>
                      <div><span className="text-slate-600">Filed:</span> {extractedData.doc.filedDate}</div>
                      {extractedData.event?.effectiveDate && (
                        <div><span className="text-slate-600">Effective:</span> {extractedData.event.effectiveDate}</div>
                      )}
                    </div>
                  </div>

                  <div>
                    <h3 className="font-semibold text-slate-900 mb-2">Event Summary</h3>
                    <div className="bg-slate-50 rounded p-3 text-sm">
                      {extractedData.event?.summary || 'No summary available'}
                    </div>
                  </div>

                  {extractedData.partnership && (
                    <div>
                      <h3 className="font-semibold text-slate-900 mb-2">Partnership Details</h3>
                      <div className="bg-slate-50 rounded p-3 text-sm space-y-1">
                        <div><span className="text-slate-600">Partners:</span> {extractedData.partnership.partnerA} × {extractedData.partnership.partnerB}</div>
                        {extractedData.partnership.scope && (
                          <div><span className="text-slate-600">Scope:</span> {extractedData.partnership.scope}</div>
                        )}
                        <div><span className="text-slate-600">Territory:</span> {extractedData.partnership.territory}</div>
                      </div>
                    </div>
                  )}

                  {extractedData.deal && (
                    <div>
                      <h3 className="font-semibold text-slate-900 mb-2">Deal Details</h3>
                      <div className="bg-slate-50 rounded p-3 text-sm space-y-1">
                        <div><span className="text-slate-600">Buyer:</span> {extractedData.deal.buyer}</div>
                        <div><span className="text-slate-600">Target:</span> {extractedData.deal.target}</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Recent Extractions */}
          <div className="space-y-6">
            <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
              <h2 className="text-lg font-bold text-slate-900 mb-4">Recent Extractions</h2>
              
              {recentExtractions.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <FileText className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No extractions yet</p>
                </div>
              ) : (
                <div className="space-y-3 max-h-[600px] overflow-y-auto">
                  {recentExtractions.slice(0, 10).map((extraction, i) => (
                    <button
                      key={i}
                      onClick={() => loadExtraction(extraction)}
                      className="w-full text-left p-3 border border-slate-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-slate-900 truncate">
                            {extraction.companyName || extraction.docId}
                          </div>
                          <div className="text-xs text-slate-500 mt-1">
                            {extraction.eventKind} • {extraction.filedDate}
                          </div>
                          {extraction.totalValueUSD > 0 && (
                            <div className="text-xs text-slate-600 mt-1">
                              ${(extraction.totalValueUSD / 1e9).toFixed(2)}B
                            </div>
                          )}
                        </div>
                        {extraction.isAI && (
                          <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded">
                            AI
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}