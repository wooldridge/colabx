import cors from 'cors';
import DigestFetch from 'digest-fetch';
import express from 'express';
import { readFile } from 'node:fs/promises';

const app = express();
const port = process.env.PORT || 3001;
const categoryConfigUrl = new URL('../data/category-config.json', import.meta.url);
const markLogicConfigUrl = new URL('../config/marklogic.local.json', import.meta.url);
const markLogicModule = '/ext/find-perf-category-run-info.xqy';

async function loadMarkLogicConfig() {
  try {
    return JSON.parse(await readFile(markLogicConfigUrl, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Unable to read MarkLogic configuration: ${error.message}`);
  }
}

const markLogicConfig = await loadMarkLogicConfig();
const markLogicUrl = process.env.MARKLOGIC_URL || markLogicConfig.url;
const markLogicUsername = process.env.MARKLOGIC_USERNAME || markLogicConfig.username;
const markLogicPassword = process.env.MARKLOGIC_PASSWORD || markLogicConfig.password;
const markLogicDatabase = process.env.MARKLOGIC_DATABASE || markLogicConfig.database || 'stats';
const jenkinsBaseUrl = process.env.JENKINS_BASE_URL || markLogicConfig.jenkinsBaseUrl;
const historyRunLimit = 6;
const historySearchPageLength = 500;
const testNamespace = 'http://www.marklogic.com/perf/test';
const llmProvider = process.env.LLM_PROVIDER || markLogicConfig['llm-provider'] || 'ollama';
const llmHost = process.env.LLM_HOST || process.env.OLLAMA_URL || markLogicConfig['llm-host'] || 'http://localhost:11434';
const llmModel = process.env.LLM_MODEL || process.env.OLLAMA_MODEL || markLogicConfig['llm-model'] || 'llama3.1:8b';
const llmApiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || markLogicConfig['llm-api-key'] || '';

const categoryBases = {
  DAILY: 'DAILY',
  'JAVA API & OTHERS': 'JAVA-API-OTHERS',
  MLCP: 'MLCP',
  SEMANTICS: 'SEMANTICS',
  GEOSPATIAL: 'GEOSPATIAL',
  SEARCH: 'SEARCH',
  'SEARCH & LOAD': 'SEARCH-LOAD'
};

app.use(cors());
app.use(express.json());

function getConnection() {
  if (!markLogicUrl || !markLogicUsername || !markLogicPassword) {
    throw new Error('MarkLogic is not configured. Set backend/config/marklogic.local.json or the MARKLOGIC_URL, MARKLOGIC_USERNAME, and MARKLOGIC_PASSWORD environment variables.');
  }

  return {
    client: new DigestFetch(markLogicUsername, markLogicPassword),
    invokeUrl: new URL('/v1/invoke', markLogicUrl).toString(),
    searchUrl: new URL('/v1/search', markLogicUrl).toString()
  };
}

/** Scheduler values are Jenkins job paths, so a build URL is the base URL plus that path. */
function jenkinsUrl(scheduler) {
  if (!jenkinsBaseUrl || !scheduler) return null;
  return `${jenkinsBaseUrl.replace(/\/$/, '')}/${scheduler.replace(/^\//, '')}`;
}

function cellParameters(category, dataCenter, architecture, version, config) {
  const isAws = dataCenter === 'AWS';
  const instanceType = !isAws
    ? undefined
    : architecture === 'Graviton'
      ? config.aws_graviton_instance_type
      : config.aws_intel_instance_type;

  return {
    schedulerType: `${isAws ? 'SCHEDULER-AWS-' : 'SCHEDULER-RH9-'}${categoryBases[category] || category.replaceAll(' ', '-').replaceAll('&', 'AND')}-${version}`,
    features: config.major_version_category_pipelines[String(version)][category],
    majorVersion: String(version),
    os: isAws ? config.os_aws : config.os_onprem,
    instanceType
  };
}

function parseMarkLogicResponse(body, contentType) {
  if (contentType.includes('application/json')) return JSON.parse(body);

  const jsonPart = body.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonPart) throw new Error('MarkLogic returned no JSON result.');
  return JSON.parse(jsonPart);
}

function displayScheduler(scheduler) {
  if (!scheduler) return scheduler;
  const schedulerIndex = scheduler.lastIndexOf('SCHEDULER-');
  return schedulerIndex >= 0 ? scheduler.slice(schedulerIndex) : scheduler;
}

async function queryCell(client, invokeUrl, category, dataCenter, architecture, version, config) {
  const parameters = cellParameters(category, dataCenter, architecture, version, config);
  const variables = {
    'SCHEDULER-TYPE': parameters.schedulerType,
    FEATURES: parameters.features.join(','),
    'MAJOR-VERSION': parameters.majorVersion,
    OS: parameters.os
  };
  if (parameters.instanceType) variables['INSTANCE-TYPE'] = parameters.instanceType;

  const form = new URLSearchParams({
    database: markLogicDatabase,
    module: markLogicModule,
    vars: JSON.stringify(variables)
  });
  const response = await client.fetch(invokeUrl, {
    method: 'POST',
    headers: {
      Accept: 'multipart/mixed; boundary=BOUNDARY',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`MarkLogic request failed with ${response.status}: ${body}`);

  const result = parseMarkLogicResponse(body, response.headers.get('content-type') || '');
  const pipelines = result.pipelines || [];
  const schedulerFull = result.scheduler || parameters.schedulerType;
  return {
    id: `${category}-${dataCenter}-${architecture}-${version}`,
    category,
    dataCenter,
    architecture,
    version: String(version),
    scheduler: displayScheduler(schedulerFull),
    schedulerFull,
    jenkinsUrl: jenkinsUrl(schedulerFull),
    mltag: result.mltag || null,
    date: result.date || null,
    expectedPipelines: parameters.features,
    pipelines,
    status: result.date ? (pipelines.length === parameters.features.length ? 'Healthy' : 'Missing') : 'Unknown'
  };
}

function testElement(name) {
  return { ns: testNamespace, name };
}

/** Parses the simple text elements returned by extract-document-data. */
function extractedFields(result) {
  const fields = {};
  for (const fragment of result.extracted?.content || []) {
    const match = /^<test:([\w-]+)\b[^>]*>([\s\S]*)<\/test:[\w-]+>$/.exec(String(fragment).trim());
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

/** Groups run documents (one per pipeline) into distinct scheduler runs, newest first. */
function groupRuns(results, expectedCount) {
  const runs = new Map();

  for (const result of results) {
    const fields = extractedFields(result);
    const scheduler = (fields.scheduler || '').replace(/\/$/, '');
    if (!scheduler) continue;

    let run = runs.get(scheduler);
    if (!run) {
      if (runs.size >= historyRunLimit) continue;
      run = { scheduler, date: fields.date || null, mltag: fields.mltag || null, pipelines: new Set() };
      runs.set(scheduler, run);
    }
    if (fields['base-feature']) run.pipelines.add(fields['base-feature']);
  }

  return [...runs.values()].map((run) => ({
    scheduler: displayScheduler(run.scheduler),
    schedulerFull: run.scheduler,
    jenkinsUrl: jenkinsUrl(run.scheduler),
    date: run.date,
    mltag: run.mltag,
    found: run.pipelines.size,
    expected: expectedCount
  }));
}

async function fetchRunHistory(client, searchUrl, parameters) {
  const queries = [
    { 'term-query': { text: [parameters.schedulerType] } },
    { 'value-query': { element: testElement('ml-major-version'), text: [parameters.majorVersion] } },
    { 'value-query': { element: testElement('ml-os-version'), text: [parameters.os] } }
  ];
  if (parameters.instanceType) {
    queries.push({ 'value-query': { element: testElement('aws-instance-type'), text: [parameters.instanceType] } });
  }

  const search = {
    search: {
      query: { queries: [{ 'and-query': { queries } }] },
      options: {
        'sort-order': [{ direction: 'descending', type: 'xs:dateTime', element: testElement('start') }],
        'extract-document-data': {
          selected: 'include',
          'extract-path': ['/*:test/*:scheduler', '/*:test/*:date', '/*:test/*:mltag', '/*:test/*:base-feature']
        }
      }
    }
  };

  const url = `${searchUrl}?database=${encodeURIComponent(markLogicDatabase)}&format=json&pageLength=${historySearchPageLength}`;
  const response = await client.fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(search)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`MarkLogic history request failed with ${response.status}: ${body}`);

  return groupRuns(JSON.parse(body).results || [], parameters.features.length);
}

app.get('/api/pipeline-status', async (_request, response, next) => {
  try {
    const config = JSON.parse(await readFile(categoryConfigUrl, 'utf8'));
    const { client, invokeUrl } = getConnection();
    const requests = config.categories.flatMap((category) => (
      Object.entries(config.columns).flatMap(([dataCenter, architectures]) => (
        Object.entries(architectures).flatMap(([architecture, versions]) => (
          versions.map((version) => queryCell(client, invokeUrl, category, dataCenter, architecture, version, config))
        ))
      ))
    ));
    const rows = await Promise.all(requests);
    response.json({ refreshedAt: new Date().toISOString(), rows });
  } catch (error) {
    next(error);
  }
});

app.get('/api/pipeline-history', async (request, response, next) => {
  try {
    const config = JSON.parse(await readFile(categoryConfigUrl, 'utf8'));
    const { category, dataCenter, architecture, version } = request.query;

    // Only accept coordinates present in the configuration, so no caller input reaches the query.
    const architectures = config.columns[dataCenter];
    if (!config.categories.includes(category) || !architectures?.[architecture]?.includes(Number(version))) {
      response.status(400).json({ error: 'Unknown pipeline coordinates.' });
      return;
    }

    const { client, searchUrl } = getConnection();
    const parameters = cellParameters(category, dataCenter, architecture, Number(version), config);
    response.json({ runs: await fetchRunHistory(client, searchUrl, parameters) });
  } catch (error) {
    next(error);
  }
});

/** Sends a prompt to the configured LLM provider and returns the generated text. */
async function askLlm(prompt) {
  const isOpenAi = llmProvider.toLowerCase() === 'openai';
  const endpoint = isOpenAi
    ? `${llmHost.replace(/\/$/, '')}/chat/completions`
    : `${llmHost.replace(/\/$/, '')}/api/generate`;
  const headers = { 'Content-Type': 'application/json' };
  if (isOpenAi && llmApiKey) headers.Authorization = `Bearer ${llmApiKey}`;

  const requestBody = isOpenAi
    ? {
        model: llmModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2
      }
    : { model: llmModel, prompt, stream: false };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${llmProvider} request failed with ${response.status}: ${body}`);

  const result = JSON.parse(body);
  return (isOpenAi ? result.choices?.[0]?.message?.content : result.response)?.trim() || '';
}

function missingPipelines(row) {
  const found = new Set(row.pipelines);
  return row.expectedPipelines.filter((pipeline) => !found.has(pipeline));
}

/** Summarizes only the rows that need attention, so the prompt stays small and focused. */
function buildSummaryPrompt(rows) {
  const attentionRows = rows.filter((row) => row.status !== 'Healthy');
  const lines = attentionRows.slice(0, 60).map((row) => (
    `- ${row.category} | ML ${row.version} | ${row.dataCenter}/${row.architecture} | status=${row.status} | last run=${row.date || 'never'} | missing=[${missingPipelines(row).join(', ') || 'none'}]`
  ));

  return [
    'You are a performance engineering assistant summarizing a pipeline monitoring dashboard.',
    'Below are the pipeline cells that currently need attention (status is not Healthy).',
    'Write a concise, well-formatted plain-text summary for an engineer glancing at the dashboard.',
    'Use exactly this structure, with one item per line and no markdown symbols or introductory text:',
    'SUMMARY: <one sentence describing the overall state>',
    'TOP ISSUES:',
    '- <grouped issue and affected pipelines>',
    'NEXT CHECKS:',
    '- <specific investigation step>',
    '- Group related issues together (e.g. by category or data center) instead of repeating every row.',
    '- Call out the most urgent items first (Failed, then Stale, then Missing, then In Progress/Unknown).',
    '- Suggest what to investigate first.',
    '- Keep it under 150 words. If the list below is empty, say everything looks healthy.',
    '',
    lines.length ? lines.join('\n') : '(no rows need attention)'
  ].join('\n');
}

/** Focuses the model on one cell plus its recent run history for a targeted investigation. */
function buildInvestigationPrompt(row, historyRuns) {
  const historyLines = (historyRuns || []).map((run) => (
    `- ${run.date || 'unknown date'} | build ${run.mltag || 'n/a'} | found ${run.found}/${run.expected} pipelines`
  ));

  return [
    'You are a performance engineering assistant helping investigate one pipeline cell on a monitoring dashboard.',
    `Cell: ${row.category}, MarkLogic ${row.version}, ${row.dataCenter}/${row.architecture}.`,
    `Current status: ${row.status}. Last run: ${row.date || 'never'}. Scheduler: ${row.schedulerFull || row.scheduler || 'unknown'}.`,
    `Missing pipelines: ${missingPipelines(row).join(', ') || 'none'}.`,
    'Recent run history (most recent first):',
    historyLines.length ? historyLines.join('\n') : '(no history available)',
    '',
    'Give the engineer a well-formatted plain-text response with no markdown symbols or introductory text.',
    'Use exactly this structure:',
    'LIKELY CAUSE:',
    '<one concise sentence>',
    'NEXT CHECKS:',
    '1. <concrete check>',
    '2. <concrete check>',
    '3. <concrete check>',
    'Use 2-4 short, concrete checks to explain this status and find the missing or failed coverage. Keep it under 120 words.'
  ].join('\n');
}

function buildChatPrompt(rows, summary, messages) {
  const attentionRows = rows.filter((row) => row.status !== 'Healthy').slice(0, 60);
  const rowLines = attentionRows.map((row) => (
    `- ${row.category} | ML ${row.version} | ${row.dataCenter}/${row.architecture} | status=${row.status} | last run=${row.date || 'never'} | missing=[${missingPipelines(row).join(', ') || 'none'}]`
  ));
  const conversation = messages.slice(-8).map((message) => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${message.content}`);

  return [
    'You are a performance engineering assistant answering a follow-up question about a pipeline monitoring dashboard.',
    'Answer only from the dashboard context below. If the data does not support an answer, say what is missing.',
    'Be concise and practical. Use plain text with short paragraphs or bullets, and do not invent pipeline results.',
    `Current generated summary: ${summary || '(no summary has been generated)'}`,
    'Pipeline cells needing attention in the current view:',
    rowLines.length ? rowLines.join('\n') : '(none; all visible cells are healthy)',
    'Conversation:',
    conversation.join('\n'),
    'Answer the latest USER question.'
  ].join('\n');
}

app.post('/api/insights/summary', async (request, response, next) => {
  try {
    const rows = Array.isArray(request.body?.rows) ? request.body.rows : [];
    const summary = await askLlm(buildSummaryPrompt(rows));
    response.json({ summary });
  } catch (error) {
    next(error);
  }
});

app.post('/api/insights/investigate', async (request, response, next) => {
  try {
    const { row, historyRuns } = request.body || {};
    if (!row || typeof row !== 'object') {
      response.status(400).json({ error: 'A pipeline row is required.' });
      return;
    }
    const analysis = await askLlm(buildInvestigationPrompt(row, historyRuns));
    response.json({ analysis });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: error.message || 'Unable to load pipeline status data.' });
});

app.listen(port, () => {
  console.log(`Pipeline Pulse API listening on http://localhost:${port}`);
});

app.post('/api/insights/chat', async (request, response, next) => {
  try {
    const { rows, summary, messages } = request.body || {};
    const userMessages = Array.isArray(messages) ? messages : [];
    const latestMessage = userMessages.at(-1);
    if (!Array.isArray(rows) || !latestMessage || latestMessage.role !== 'user' || typeof latestMessage.content !== 'string' || !latestMessage.content.trim()) {
      response.status(400).json({ error: 'A follow-up question and dashboard rows are required.' });
      return;
    }
    if (latestMessage.content.length > 500) {
      response.status(400).json({ error: 'The follow-up question is too long.' });
      return;
    }
    const answer = await askLlm(buildChatPrompt(rows, typeof summary === 'string' ? summary.slice(0, 2000) : '', userMessages));
    response.json({ answer });
  } catch (error) {
    next(error);
  }
});