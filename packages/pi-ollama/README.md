# pi-ollama

Automatically registers your local Ollama server as a Pi model provider.

The package discovers locally available, already-pulled Ollama models from `/api/tags`, reads each model's metadata from `/api/show`, and registers them with Pi through Ollama's OpenAI-compatible `/v1/chat/completions` endpoint.

## Install

```bash
pi install npm:pi-ollama
```

For local development:

```bash
pi -e /path/to/pi-mono/packages/pi-ollama --list-models
```

## Usage

1. Start Ollama.
2. Pull one or more models, for example:

   ```bash
   ollama pull qwen3:8b
   ollama pull gemma3:4b
   ```

3. Start Pi and select an `ollama/<model>` entry from `/model`.

## Configuration

By default, `pi-ollama` uses `http://localhost:11434`.

Environment variables:

- `PI_OLLAMA_HOST` — preferred Ollama base URL, host, or `host:port`.
- `OLLAMA_HOST` — used when `PI_OLLAMA_HOST` is unset.
- `OLLAMA_BASE_URL` — fallback base URL.
- `PI_OLLAMA_TIMEOUT_MS` — discovery request timeout, default `3000`.

Examples:

```bash
PI_OLLAMA_HOST=http://127.0.0.1:11434 pi
PI_OLLAMA_HOST=192.168.1.10:11434 pi --list-models
```

## Model configuration

For each local model, `pi-ollama` configures:

- model id and display name
- context window from `PARAMETER num_ctx` or `*.context_length` metadata
- max output tokens from `PARAMETER num_predict`, otherwise a conservative context-based value
- vision input when Ollama reports the `vision` capability
- reasoning/thinking when Ollama reports `thinking`, plus known thinking families such as Qwen 3, DeepSeek R1/V3.1, and GPT-OSS
- zero token cost, because inference is local

If Ollama is not running, the provider is still registered with no models so Pi startup is not blocked. Start Ollama and reload Pi to rediscover models.
