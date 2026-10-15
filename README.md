# DevOps AI Chat

A simple Indonesian chat UI with a Node.js backend and integrations for AI providers, GitHub, Render, and Firebase Hosting CLI.

## Important: setup is required
This ZIP is a runnable starter, not a pre-connected account. You must add your own API credentials and choose the providers/services you want enabled. Manus is supported through its Responses API. Keep `MANUS_API_KEY` only in Render Environment Variables; never commit it to GitHub or place it in chat.

## Run locally
1. Install Node.js 20+.
2. Extract this ZIP.
3. Copy `.env.example` to `.env` and fill in credentials.
4. Run `npm install`
5. Run `npm start`
6. Open `http://localhost:3000`

## AI provider setup
- `AI_PROVIDER`: `manus`, `openai`, `anthropic`, `gemini`, or `openai-compatible`
- `AI_API_KEY`: key for the selected provider
- `AI_MODEL`: model name supported by that provider
- `AI_BASE_URL`: required for `openai-compatible`, set to the provider's documented API base URL.
- `MANUS_API_KEY`: Manus API key, configured only as a secret in Render.
- `MANUS_MODEL`: Manus model such as `manus-1.6-lite`, `manus-1.6`, or `manus-1.6-max`.
- `MANUS_BASE_URL`: defaults to `https://api.manus.ai/v1/responses`.
- `GEMINI_API_KEY`: Gemini API key, configured only as a secret in Render.
- `GEMINI_MODEL`: fallback model, default `gemini-2.0-flash`.
- `AI_FALLBACK_ORDER`: provider order to try when a provider reports quota/rate-limit or server errors. Add a separate key for each provider using `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and optional `COMPAT_API_KEY` / `COMPAT_BASE_URL`.
- Fallback is only possible when credentials are configured and the provider has a compatible API. It cannot detect an account's exact remaining credit unless the provider exposes that information. Displayed quota is therefore "unknown" unless provider response indicates a quota/rate-limit error.

Supported environment keys:
`OPENAI_API_KEY`, `OPENAI_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `COMPAT_API_KEY`, `COMPAT_MODEL`, `COMPAT_BASE_URL`, `MANUS_API_KEY`, `MANUS_MODEL`, `MANUS_BASE_URL`.

## GitHub
Set `GITHUB_TOKEN`. Optionally set `GITHUB_OWNER` and `GITHUB_REPO` to check a specific repository. Use a fine-grained token with minimum required permissions. Chat actions that write files/commit/push are not enabled by default; the assistant can inspect status and guide you. Do not expose tokens in chat.

## Render
Set `RENDER_API_KEY`. This enables listing services and deployment triggers through the Render API. Keep the key server-side.

## Firebase Hosting
Set `FIREBASE_TOKEN` and `FIREBASE_PROJECT_ID` to enable deployment through Firebase CLI. Install Firebase CLI in the environment (`npm install -g firebase-tools`) if using the optional deploy endpoint. On Render, a Firebase CLI token can expire; use a CI service account or dedicated deployment pipeline for production. Do not upload service account JSON to a public repository.

## Security
- Keep `.env` out of Git.
- Use HTTPS and a strong `SESSION_SECRET` in production.
- Put the app behind authentication before exposing it publicly. This starter includes a simple local admin password gate only if `APP_PASSWORD` is set.
- Never deploy this panel publicly without access control and credentials restricted to least privilege.
- AI responses are untrusted. This app does not execute arbitrary shell commands from AI.
