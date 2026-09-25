import { useEffect, useState } from 'react';
import { BarChart3, CalendarDays, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Clock, Cpu, Database, ExternalLink, Heart, Layers, MessageCircle, PieChart, RotateCcw, Send, Server, Sparkles, Tag, TriangleAlert, X } from 'lucide-react';
import { createRows, statusPriority } from './status.js';

const pageSize = 10;
const autoRefreshIntervalMs = 60_000;
const historyRunLimit = 6;

function formatDate(value) {
  if (!value) return 'Not available';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(new Date(value));
}

function formatTimestamp(value) {
  if (!value) return 'Not available';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC'
  }).format(new Date(value));
}

function StatusBadge({ status }) {
  return <span className={`status status-${status.toLowerCase().replace(' ', '-')}`}>{status}</span>;
}

function exportFields(row) {
  const foundPipelines = new Set(row.pipelines);
  const missingPipelines = row.expectedPipelines.filter((pipeline) => !foundPipelines.has(pipeline));
  return [
    row.version, row.category, row.status, row.dataCenter, row.architecture,
    row.scheduler, row.mltag || '', row.date || '',
    `${row.pipelines.length} of ${row.expectedPipelines.length}`,
    row.pipelines.join('; '), missingPipelines.join('; ')
  ];
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function downloadFile(contents, name, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function App() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState({ key: 'status', direction: 'asc' });
  const [page, setPage] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [versionFilter, setVersionFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowId, setSelectedRowId] = useState(null);
  const [history, setHistory] = useState({ status: 'idle', runs: [] });
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [aiSummary, setAiSummary] = useState({ status: 'idle', text: '' });
  const [investigation, setInvestigation] = useState({ status: 'idle', text: '' });
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatStatus, setChatStatus] = useState('idle');
  const [aiPanelCollapsed, setAiPanelCollapsed] = useState(false);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/pipeline-status');
      if (!response.ok) throw new Error(`Request failed with ${response.status}`);
      setPayload(await response.json());
      setPage(1);
    } catch (requestError) {
      setError('Pipeline status data could not be loaded. Confirm that the API is running.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!autoRefreshEnabled) return undefined;

    const intervalId = window.setInterval(loadData, autoRefreshIntervalMs);
    return () => window.clearInterval(intervalId);
  }, [autoRefreshEnabled]);

  const rows = payload ? createRows(payload) : [];
  const selectedRow = rows.find((row) => row.id === selectedRowId) || null;

  useEffect(() => {
    if (!selectedRow) {
      setHistory({ status: 'idle', runs: [] });
      return undefined;
    }

    let active = true;
    const parameters = new URLSearchParams({
      category: selectedRow.category,
      dataCenter: selectedRow.dataCenter,
      architecture: selectedRow.architecture,
      version: selectedRow.version
    });

    setHistory({ status: 'loading', runs: [] });
    fetch(`/api/pipeline-history?${parameters}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((data) => active && setHistory({ status: 'ready', runs: data.runs || [] }))
      .catch(() => active && setHistory({ status: 'error', runs: [] }));

    return () => { active = false; };
  }, [selectedRowId, payload]);

  useEffect(() => {
    setInvestigation({ status: 'idle', text: '' });
  }, [selectedRowId]);

  async function generateAiSummary(rowsForSummary) {
    setChatMessages([]);
    setChatInput('');
    setChatStatus('idle');
    setAiSummary({ status: 'loading', text: '' });
    try {
      const response = await fetch('/api/insights/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: rowsForSummary })
      });
      if (!response.ok) throw new Error(`Request failed with ${response.status}`);
      const data = await response.json();
      setAiSummary({ status: 'ready', text: data.summary || '' });
    } catch (requestError) {
      setAiSummary({ status: 'error', text: 'AI insights are unavailable. Confirm Ollama is running.' });
    }
  }

  async function investigateRow(row, historyRuns) {
    setInvestigation({ status: 'loading', text: '' });
    try {
      const response = await fetch('/api/insights/investigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row, historyRuns })
      });
      if (!response.ok) throw new Error(`Request failed with ${response.status}`);
      const data = await response.json();
      setInvestigation({ status: 'ready', text: data.analysis || '' });
    } catch (requestError) {
      setInvestigation({ status: 'error', text: 'AI investigation is unavailable. Confirm Ollama is running.' });
    }
  }

  async function askFollowUp(event) {
    event.preventDefault();
    const question = chatInput.trim();
    if (!question || chatStatus === 'loading') return;

    const nextMessages = [...chatMessages, { role: 'user', content: question }];
    setChatMessages(nextMessages);
    setChatInput('');
    setChatStatus('loading');
    try {
      const response = await fetch('/api/insights/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: scopedRows, summary: aiSummary.text, messages: nextMessages })
      });
      if (!response.ok) throw new Error(`Request failed with ${response.status}`);
      const data = await response.json();
      setChatMessages([...nextMessages, { role: 'assistant', content: data.answer || 'I could not find an answer in the current dashboard data.' }]);
      setChatStatus('ready');
    } catch (requestError) {
      setChatMessages([...nextMessages, { role: 'assistant', content: 'The follow-up is unavailable. Confirm Ollama is running and try again.' }]);
      setChatStatus('error');
    }
  }

  function clearChat() {
    setChatMessages([]);
    setChatInput('');
    setChatStatus('idle');
  }

  const categoryOptions = [...new Set(rows.map((row) => row.category))].sort((a, b) => a.localeCompare(b));
  const versionOptions = [...new Set(rows.map((row) => row.version))].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  const scopedRows = rows.filter((row) => (
    (categoryFilter === 'all' || row.category === categoryFilter)
    && (versionFilter === 'all' || row.version === versionFilter)
  ));
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  const filteredRows = scopedRows.filter((row) => {
    if (statusFilter === 'attention' && row.status === 'Healthy') return false;
    if (statusFilter !== 'all' && statusFilter !== 'attention' && row.status !== statusFilter) return false;
    if (!normalizedSearchTerm) return true;

    const searchableValues = [
      row.category, row.status, row.dataCenter, row.architecture, row.version,
      row.scheduler, row.schedulerFull, row.mltag, row.date, ...row.pipelines, ...row.expectedPipelines
    ];
    return searchableValues.some((value) => String(value || '').toLowerCase().includes(normalizedSearchTerm));
  });
  const sortedRows = [...filteredRows].sort((first, second) => {
    const firstValue = sort.key === 'status' ? statusPriority[first.status] : first[sort.key] ?? '';
    const secondValue = sort.key === 'status' ? statusPriority[second.status] : second[sort.key] ?? '';
    const comparison = String(firstValue).localeCompare(String(secondValue), undefined, { numeric: true });
    return sort.direction === 'asc' ? comparison : -comparison;
  });
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const visibleRows = sortedRows.slice((page - 1) * pageSize, page * pageSize);

  function changeSort(key) {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc'
    }));
    setPage(1);
  }

  const monitoredCount = scopedRows.length;
  const healthyCount = scopedRows.filter((row) => row.status === 'Healthy').length;
  const attentionCount = monitoredCount - healthyCount;
  const gapRate = monitoredCount ? Math.round((attentionCount / monitoredCount) * 100) : 0;

  function changeCategoryFilter(value) {
    setCategoryFilter(value);
    setPage(1);
  }

  function changeVersionFilter(value) {
    setVersionFilter(value);
    setPage(1);
  }

  function changeSearchTerm(value) {
    setSearchTerm(value);
    setPage(1);
  }

  function toggleStatusFilter(status) {
    setStatusFilter((current) => (current === status ? 'all' : status));
    setPage(1);
  }

  function exportCsv() {
    const headers = ['Version', 'Category', 'Status', 'Data center', 'Architecture', 'Scheduler', 'Build tag', 'Run date', 'Coverage', 'Found pipelines', 'Missing pipelines'];
    const csv = [headers, ...sortedRows.map(exportFields)]
      .map((values) => values.map(csvCell).join(','))
      .join('\n');
    downloadFile(csv, 'pipeline-pulse.csv', 'text/csv;charset=utf-8');
  }

  async function exportPdf() {
    const [{ jsPDF }, { default: autoTable }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable')
    ]);
    const document = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
    document.setFontSize(16);
    document.text('Pipeline Pulse', 36, 36);
    document.setFontSize(9);
    document.setTextColor(82, 97, 110);
    document.text(`${sortedRows.length} filtered performance run cells`, 36, 51);
    autoTable(document, {
      startY: 64,
      head: [['Version', 'Category', 'Status', 'Data center', 'Architecture', 'Scheduler', 'Build tag', 'Run date', 'Coverage', 'Found pipelines', 'Missing pipelines']],
      body: sortedRows.map(exportFields),
      margin: { left: 28, right: 28 },
      styles: { fontSize: 6.5, cellPadding: 3, overflow: 'linebreak' },
      headStyles: { fillColor: [46, 62, 79], textColor: 255 },
      columnStyles: { 5: { cellWidth: 92 }, 9: { cellWidth: 100 }, 10: { cellWidth: 100 } }
    });
    document.save('pipeline-pulse.pdf');
  }

  return (
    <main>
      <header className="app-header">
        <div>
          <p className="eyebrow">Performance Engineering</p>
          <h1>Pipeline Pulse</h1>
          <p className="subtitle">Real-time MarkLogic performance pipeline health and coverage</p>
        </div>
        <div className="header-actions">
          <label className="auto-refresh-toggle">
            <input
              type="checkbox"
              checked={autoRefreshEnabled}
              onChange={(event) => setAutoRefreshEnabled(event.target.checked)}
            />
            <span>Auto-refresh</span>
          </label>
          <button className="refresh" type="button" onClick={loadData} disabled={loading} aria-label="Refresh pipeline status">
            <span aria-hidden="true">↻</span> Refresh
          </button>
        </div>
      </header>

      {payload && <section className="summary" aria-label="Pipeline status summary">
        <button
          type="button"
          className={`summary-card${statusFilter === 'all' ? ' summary-card-active' : ''}`}
          onClick={() => toggleStatusFilter('all')}
          aria-pressed={statusFilter === 'all'}
        >
          <span className="summary-icon"><Layers size={20} /></span>
          <span className="summary-body">
            <span className="summary-label">Pipelines monitored</span>
            <strong>{monitoredCount}</strong>
            <small>Configured combinations</small>
          </span>
        </button>
        <button
          type="button"
          className={`summary-card summary-card-healthy${statusFilter === 'Healthy' ? ' summary-card-active' : ''}`}
          onClick={() => toggleStatusFilter('Healthy')}
          aria-pressed={statusFilter === 'Healthy'}
        >
          <span className="summary-icon"><Heart size={20} /></span>
          <span className="summary-body">
            <span className="summary-label">Healthy coverage</span>
            <strong>{healthyCount}</strong>
            <small>All expected pipelines found</small>
          </span>
        </button>
        <button
          type="button"
          className={`summary-card summary-card-attention${statusFilter === 'attention' ? ' summary-card-active' : ''}`}
          onClick={() => toggleStatusFilter('attention')}
          aria-pressed={statusFilter === 'attention'}
        >
          <span className="summary-icon"><TriangleAlert size={20} /></span>
          <span className="summary-body">
            <span className="summary-label">Need attention</span>
            <strong>{attentionCount}</strong>
            <small>Missing or unknown coverage</small>
          </span>
        </button>
        <button
          type="button"
          className={`summary-card summary-card-health-status${statusFilter === 'Healthy' ? ' summary-card-active' : ''}`}
          onClick={() => toggleStatusFilter('Healthy')}
          aria-pressed={statusFilter === 'Healthy'}
        >
          <span className="summary-icon"><Heart size={20} /></span>
          <span className="summary-body">
            <span className="summary-label">Health status</span>
            <strong>{monitoredCount ? Math.round((healthyCount / monitoredCount) * 100) : 0}%</strong>
            <small>Passed pipelines</small>
          </span>
        </button>
        <button
          type="button"
          className={`summary-card summary-card-gap${statusFilter === 'attention' ? ' summary-card-active' : ''}`}
          onClick={() => toggleStatusFilter('attention')}
          aria-pressed={statusFilter === 'attention'}
        >
          <span className="summary-icon"><PieChart size={20} /></span>
          <span className="summary-body">
            <span className="summary-label">Coverage gaps</span>
            <strong>{gapRate}%</strong>
            <small>Monitored pipelines</small>
          </span>
        </button>
      </section>}

      {payload && <section className="ai-panel" aria-label="AI-generated insights">
        <div className="ai-panel-heading">
          <button
            type="button"
            className="ai-panel-toggle"
            onClick={() => setAiPanelCollapsed((collapsed) => !collapsed)}
            aria-expanded={!aiPanelCollapsed}
            aria-controls="ai-panel-content"
          >
            {aiPanelCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            <h2><Sparkles size={18} /> AI insights</h2>
          </button>
          <button
            type="button"
            className="ai-generate-button"
            onClick={() => generateAiSummary(scopedRows)}
            disabled={aiSummary.status === 'loading'}
          >
            {aiSummary.status === 'loading' ? 'Thinking…' : 'Generate insights'}
          </button>
        </div>
        {!aiPanelCollapsed && <div id="ai-panel-content">
          {aiSummary.status === 'idle' && <p className="ai-panel-note">Ask AI to summarize what needs attention across the pipelines currently in view.</p>}
          {aiSummary.status === 'error' && <p className="ai-panel-note ai-panel-error">{aiSummary.text}</p>}
          {aiSummary.status === 'ready' && <p className="ai-panel-text">{aiSummary.text || 'Everything looks healthy.'}</p>}
          <div className="ai-chat">
            {chatMessages.length > 0 && <div className="ai-chat-messages" aria-live="polite">
              {chatMessages.map((message, index) => (
                <div className={`ai-chat-message ai-chat-message-${message.role}`} key={`${message.role}-${index}`}>
                  <span>{message.role === 'user' ? 'You' : 'AI'}</span>
                  <p>{message.content}</p>
                </div>
              ))}
            </div>}
            <form className="ai-chat-form" onSubmit={askFollowUp}>
              <MessageCircle size={17} aria-hidden="true" />
              <input
                type="text"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder="Ask a question about the pipelines in view"
                aria-label="Ask a question about the pipelines in view"
                maxLength={500}
              />
              <button type="button" className="ai-chat-clear" onClick={clearChat} aria-label="Start a new conversation" title="Start a new conversation" disabled={!chatMessages.length || chatStatus === 'loading'}>
                <RotateCcw size={15} />
              </button>
              <button type="submit" aria-label="Send follow-up question" title="Send follow-up question" disabled={!chatInput.trim() || chatStatus === 'loading'}>
                <Send size={16} />
              </button>
            </form>
          </div>
        </div>}
      </section>}

      <div className={`dashboard-layout${selectedRow ? ' inspector-open' : ''}`}>
      <section className="panel" aria-live="polite">
        <div className="table-heading">
          <div>
            <h2><BarChart3 size={20} /> Performance pipeline coverage</h2>
            <p>{payload ? `Data refreshed ${formatTimestamp(payload.refreshedAt)} UTC` : 'Loading latest status...'}</p>
          </div>
        </div>

        {payload && <div className="filters">
          <label className="filter filter-search">
            <span>Search</span>
            <input
              type="search"
              value={searchTerm}
              onChange={(event) => changeSearchTerm(event.target.value)}
              placeholder="Search all row details"
              aria-label="Search all pipeline rows"
            />
          </label>
          <label className="filter">
            <span>Category</span>
            <select value={categoryFilter} onChange={(event) => changeCategoryFilter(event.target.value)}>
              <option value="all">All categories</option>
              {categoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </label>
          <label className="filter">
            <span>Release version</span>
            <select value={versionFilter} onChange={(event) => changeVersionFilter(event.target.value)}>
              <option value="all">All versions</option>
              {versionOptions.map((version) => <option key={version} value={version}>{version}</option>)}
            </select>
          </label>
          {(searchTerm || categoryFilter !== 'all' || versionFilter !== 'all' || statusFilter !== 'all') && (
            <div className="filter-status">
              {statusFilter !== 'all' && <span className="filter-chip">Status: <strong>{statusFilter === 'attention' ? 'Needs attention' : statusFilter}</strong></span>}
              <button type="button" className="clear-filters" onClick={() => { changeSearchTerm(''); changeCategoryFilter('all'); changeVersionFilter('all'); toggleStatusFilter('all'); }}>Clear filters</button>
            </div>
          )}
        </div>}

        {error && <div className="error">{error}</div>}
        {loading && !payload && <div className="loading">Loading pipeline status...</div>}
        {payload && <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  ['version', 'Version'], ['category', 'Category'], ['status', 'Status'], ['dataCenter', 'Data center'], ['architecture', 'Architecture'],
                  ['scheduler', 'Scheduler'], ['mltag', 'Build tag'], ['date', 'Run date'], ['coverage', 'Coverage']
                ].map(([key, label]) => (
                  <th key={key} aria-sort={sort.key === key ? `${sort.direction}ending` : 'none'}>
                    <button type="button" onClick={() => changeSort(key)}>{label}{sort.key === key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const coveragePercent = row.expectedPipelines.length
                  ? Math.min(100, (row.pipelines.length / row.expectedPipelines.length) * 100)
                  : 0;

                return <tr
                  className={`data-row${selectedRowId === row.id ? ' data-row-selected' : ''}`}
                  key={row.id}
                  onClick={() => setSelectedRowId(row.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedRowId(row.id);
                    }
                  }}
                  tabIndex="0"
                  aria-selected={selectedRowId === row.id}
                >
                    <td className="version-cell">{row.version}</td>
                    <td>{row.category}</td>
                    <td><StatusBadge status={row.status} /></td>
                    <td>{row.dataCenter}</td>
                    <td>{row.architecture}</td>
                    <td><code className="scheduler-value" title={row.schedulerFull || row.scheduler}>{row.scheduler}</code></td>
                    <td>{row.mltag || 'Not available'}</td>
                    <td>{formatDate(row.date)}</td>
                    <td>
                      <span className="coverage" aria-label={`${row.pipelines.length} of ${row.expectedPipelines.length} expected pipelines found`}>
                        <span
                          className="coverage-track"
                          role="progressbar"
                          aria-valuemin="0"
                          aria-valuemax={row.expectedPipelines.length}
                          aria-valuenow={row.pipelines.length}
                          style={{ '--coverage-percent': `${coveragePercent}%` }}
                        >
                          <span className="coverage-fill" />
                        </span>
                        <span className="coverage-label">{row.pipelines.length}/{row.expectedPipelines.length}</span>
                      </span>
                    </td>
                  </tr>;
              })}
            </tbody>
          </table>
        </div>}

        {payload && <footer className="pagination">
          <span>{filteredRows.length} performance run cells</span>
          <div className="pagination-actions">
            <button type="button" className="export-button" onClick={exportCsv} disabled={!sortedRows.length}>Export CSV</button>
            <button type="button" className="export-button" onClick={exportPdf} disabled={!sortedRows.length}>Export PDF</button>
            <button type="button" onClick={() => setPage(page - 1)} disabled={page === 1}>Previous</button>
            <span>Page {page} of {pageCount}</span>
            <button type="button" onClick={() => setPage(page + 1)} disabled={page === pageCount}>Next</button>
          </div>
        </footer>}
      </section>
      {selectedRow && <aside className="inspector" aria-label="Selected pipeline details">
        <header className="inspector-header">
          <div>
            <h2>{selectedRow.category} · ML {selectedRow.version} · {selectedRow.dataCenter} · {selectedRow.architecture}</h2>
            <StatusBadge status={selectedRow.status} />
          </div>
          <button type="button" className="inspector-close" onClick={() => setSelectedRowId(null)} aria-label="Close pipeline details"><X size={18} /></button>
        </header>
        <div className="inspector-body">
          <section className="detail-coverage">
            <div className="detail-section-label">Pipeline coverage</div>
            <div className="detail-coverage-line">
              <span className="coverage-track detail-coverage-track" role="progressbar" aria-valuemin="0" aria-valuemax={selectedRow.expectedPipelines.length} aria-valuenow={selectedRow.pipelines.length} style={{ '--coverage-percent': `${selectedRow.expectedPipelines.length ? Math.min(100, (selectedRow.pipelines.length / selectedRow.expectedPipelines.length) * 100) : 0}%` }}><span className="coverage-fill" /></span>
              <strong>{selectedRow.pipelines.length}/{selectedRow.expectedPipelines.length}</strong>
            </div>
            <p className="coverage-note">{Math.max(0, selectedRow.expectedPipelines.length - new Set(selectedRow.pipelines).size)} pipeline{selectedRow.expectedPipelines.length - new Set(selectedRow.pipelines).size === 1 ? '' : 's'} missing</p>
          </section>
          <dl className="detail-metadata">
            <div><dt><Tag size={14} /> Build tag</dt><dd>{selectedRow.mltag || 'Not available'}</dd></div>
            <div><dt><CalendarDays size={14} /> Run date</dt><dd>{formatDate(selectedRow.date)}</dd></div>
            <div><dt><Database size={14} /> Data center</dt><dd>{selectedRow.dataCenter}</dd></div>
            <div><dt><Cpu size={14} /> Architecture</dt><dd>{selectedRow.architecture}</dd></div>
            <div className="detail-scheduler"><dt><Server size={14} /> Scheduler</dt><dd title={selectedRow.schedulerFull || selectedRow.scheduler}>{selectedRow.scheduler}</dd></div>
            {selectedRow.jenkinsUrl && <div className="detail-jenkins">
              <dt><ExternalLink size={14} /> Jenkins</dt>
              <dd><a className="jenkins-link" href={selectedRow.jenkinsUrl} target="_blank" rel="noreferrer" title={selectedRow.jenkinsUrl}>View pipeline run <ExternalLink size={13} /></a></dd>
            </div>}
          </dl>
          <div className="detail-pipelines">
            <section className="detail-pipeline-list detail-found">
              <h3><CheckCircle2 size={18} /> Found pipelines <span>{selectedRow.pipelines.length}</span></h3>
              <ul>
                {selectedRow.pipelines.map((pipeline) => <li key={pipeline}>{pipeline}</li>)}
                {!selectedRow.pipelines.length && <li className="pipeline-empty">No expected pipelines found.</li>}
              </ul>
            </section>
            <section className="detail-pipeline-list detail-missing">
              <h3><CircleAlert size={18} /> Missing pipelines <span>{selectedRow.expectedPipelines.filter((pipeline) => !new Set(selectedRow.pipelines).has(pipeline)).length}</span></h3>
              <ul>
                {selectedRow.expectedPipelines.filter((pipeline) => !new Set(selectedRow.pipelines).has(pipeline)).map((pipeline) => <li key={pipeline}>{pipeline}</li>)}
                {!selectedRow.expectedPipelines.filter((pipeline) => !new Set(selectedRow.pipelines).has(pipeline)).length && <li className="pipeline-empty">No pipelines missing.</li>}
              </ul>
            </section>
          </div>
          <section className="detail-history">
            <h3><Clock size={16} /> Recent history <span>last {history.runs.length || historyRunLimit} runs</span></h3>
            {history.status === 'loading' && <p className="history-note">Loading run history…</p>}
            {history.status === 'error' && <p className="history-note history-error">Run history could not be loaded.</p>}
            {history.status === 'ready' && !history.runs.length && <p className="history-note">No previous runs found.</p>}
            {history.status === 'ready' && history.runs.length > 0 && <ul className="history-list">
              {history.runs.map((run) => {
                const percent = run.expected ? Math.min(100, (run.found / run.expected) * 100) : 0;
                const complete = run.found >= run.expected;
                const card = <>
                  <span className="history-date">{run.date || 'Unknown date'}</span>
                  <span className={`history-count${complete ? ' history-count-complete' : ''}`}>{run.found}/{run.expected}</span>
                  <span className="coverage-track" style={{ '--coverage-percent': `${percent}%` }}>
                    <span className={`coverage-fill${complete ? '' : ' coverage-fill-partial'}`} />
                  </span>
                  <span className="history-tag">{run.mltag || run.scheduler}</span>
                </>;

                return <li key={run.schedulerFull}>
                  {run.jenkinsUrl
                    ? <a className="history-item history-item-link" href={run.jenkinsUrl} target="_blank" rel="noreferrer" title={run.schedulerFull}>{card}</a>
                    : <span className="history-item" title={run.schedulerFull}>{card}</span>}
                </li>;
              })}
            </ul>}
          </section>
          <section className="detail-ai">
            <h3><Sparkles size={16} /> AI investigation</h3>
            <button
              type="button"
              className="ai-investigate-button"
              onClick={() => investigateRow(selectedRow, history.runs)}
              disabled={investigation.status === 'loading'}
            >
              {investigation.status === 'loading' ? 'Thinking…' : 'Ask AI what to check'}
            </button>
            {investigation.status === 'error' && <p className="ai-panel-note ai-panel-error">{investigation.text}</p>}
            {investigation.status === 'ready' && <p className="ai-panel-text">{investigation.text}</p>}
          </section>
        </div>
      </aside>}
      </div>
    </main>
  );
}

export default App;