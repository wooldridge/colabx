# Backend

The backend is an Express application that queries the same MarkLogic REST
endpoint and XQuery module used by `marklogic-perfRunStatus`. Credentials stay
on the server; the browser only calls the local API.

## Run

From the repository root, install all workspace dependencies once:

```sh
npm install
```

Create `backend/config/marklogic.local.json` from
[config/marklogic.example.json](config/marklogic.example.json), enter the password,
then start the API:

```sh
npm run dev:backend
```

The local config is gitignored. Environment variables (`MARKLOGIC_URL`,
`MARKLOGIC_USERNAME`, `MARKLOGIC_PASSWORD`, and `MARKLOGIC_DATABASE`) override
its values when set.

Set `jenkinsBaseUrl` (or `JENKINS_BASE_URL`) to turn scheduler paths into Jenkins
links. Scheduler values returned by MarkLogic are Jenkins job paths, so the build
URL is that base plus the path. Links are hidden when it is not configured.

The API listens at `http://localhost:3001`. Its endpoints are:

```text
GET  /api/pipeline-status
GET  /api/pipeline-history
POST /api/insights/summary
POST /api/insights/investigate
POST /api/insights/chat
```

The chat endpoint accepts the rows currently visible in the dashboard, the
latest generated summary, and the conversation turns:

```json
{
	"rows": [],
	"summary": "...",
	"messages": [
		{ "role": "user", "content": "Which pipelines need attention first?" }
	]
}
```

Questions are limited to 500 characters. The backend uses the latest eight
conversation turns and up to 60 rows needing attention to keep the prompt
focused. It returns the answer as `{ "answer": "..." }`.

For each category, data center, architecture, and version, `GET /api/pipeline-status`
invokes `/ext/find-perf-category-run-info.xqy` through MarkLogic's `/v1/invoke`
endpoint using HTTP Digest authentication. The cell matrix and expected features
are in [data/category-config.json](data/category-config.json), aligned with the
desktop app's `category-config.jsonc`.

## AI insights

`POST /api/insights/summary`, `POST /api/insights/investigate`, and
`POST /api/insights/chat` call the configured LLM provider to turn dashboard
data into plain-language summaries, investigation suggestions, and follow-up
answers. The chat prompt is scoped to the rows currently in view and includes
the generated summary plus recent conversation turns. For local
[Ollama](https://ollama.com), pull a model, for example:

```sh
ollama pull llama3.1:8b
```

The checked-in local configuration uses Ollama by default. To use Ollama, set
`llm-provider` to `ollama`, `llm-host` to `http://localhost:11434`, and
`llm-model` to the pulled model. To use OpenAI, replace those values with:

```json
{
	"llm-provider": "openai",
	"llm-host": "https://api.openai.com/v1",
	"llm-model": "gpt-4o-mini",
	"llm-api-key": "your-api-key"
}
```

The API key can also be supplied through `LLM_API_KEY` or `OPENAI_API_KEY`;
environment variables take precedence over the config file:

```text
LLM_PROVIDER
LLM_HOST
LLM_MODEL
LLM_API_KEY
```

`llm-host` should be the provider base URL, such as
`https://api.openai.com/v1`; the backend appends the provider's chat-completion
path. The API key remains on the backend and is never sent to the browser.