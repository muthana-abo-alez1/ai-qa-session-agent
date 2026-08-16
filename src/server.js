import 'dotenv/config';
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_WEIGHT_KEYS, normalizeActionSettings } from './planner.js';

// This must be set before Playwright is imported so Chromium stays project-local.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';
const { runSession } = await import('./session-runner.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);

function requireAppLogin(request, response, next) {
  const password = process.env.APP_PASSWORD?.trim();
  if (!password) return next();

  const username = process.env.APP_USERNAME?.trim() || 'admin';
  const header = request.get('authorization');
  const encodedCredentials = header?.startsWith('Basic ') ? header.slice(6) : '';
  const suppliedCredentials = Buffer.from(encodedCredentials, 'base64').toString('utf8');
  const expectedCredentials = `${username}:${password}`;
  const supplied = Buffer.from(suppliedCredentials);
  const expected = Buffer.from(expectedCredentials);
  const isValid = supplied.length === expected.length && timingSafeEqual(supplied, expected);

  if (isValid) return next();
  response.set('WWW-Authenticate', 'Basic realm="QA Session Agent", charset="UTF-8"');
  return response.status(401).send('Login required.');
}

app.use(express.json());
app.use(requireAppLogin);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/reports', express.static(path.join(__dirname, '..', 'reports')));
const activeRuns = new Map();

function validateActionSettings(value) {
  const settings = normalizeActionSettings(value);
  const total = ACTION_WEIGHT_KEYS.reduce((sum, type) => sum + settings.weights[type], 0);
  if (total !== 100) throw new Error(`Event probabilities must add up to exactly 100%. Current total: ${total}%.`);
  const requiredAtZero = settings.required.filter((type) => settings.weights[type] === 0);
  if (requiredAtZero.length) throw new Error(`A required event cannot have 0% probability: ${requiredAtZero.join(', ')}.`);
  return settings;
}

app.post('/api/sessions', async (request, response) => {
  const { url, maxSteps = Number(process.env.MAX_STEPS || 60), sessionCount = 1, actionSettings = {}, maxDurationSeconds, deviceMode = 'desktop', sessionMode = 'random', runId } = request.body ?? {};
  const limit = Number(process.env.MAX_SESSION_COUNT || 10);
  const count = Math.min(Math.max(Number.parseInt(sessionCount, 10) || 1, 1), limit);

  try {
    const validatedActionSettings = validateActionSettings(actionSettings);
    if (!validatedActionSettings.useLocalPlanner && !process.env.OPENAI_API_KEY?.trim()) {
      throw new Error('AI planner is enabled, but OPENAI_API_KEY is missing. Add a valid key to .env, then restart the server.');
    }
    const requestedDuration = Number(maxDurationSeconds);
    const durationLimit = Number.isFinite(requestedDuration) && requestedDuration > 0
      ? Math.min(Math.max(requestedDuration, 5), 3600)
      : undefined;
    const selectedDeviceMode = ['desktop', 'mobile', 'mixed'].includes(deviceMode) ? deviceMode : 'desktop';
    const run = runId ? { events: [], stop: false, status: 'Running' } : undefined;
    if (runId) activeRuns.set(runId, run);
    const results = [];
    let firstSessionPlan = [];
    for (let index = 0; index < count; index += 1) {
      const result = await runSession({
        url,
        maxSteps: Number(maxSteps),
        actionSettings: validatedActionSettings,
        maxDurationSeconds: durationLimit,
        deviceMode: selectedDeviceMode,
        replayPlan: sessionMode === 'replay' && index > 0 ? firstSessionPlan : [],
        shouldStop: () => run?.stop === true,
        onEvent: (event) => run?.events.push(event)
      });
      if (index === 0) firstSessionPlan = result.actionPlan;
      results.push(result);
    }
    if (run) run.status = 'Completed';
    response.status(201).json({ requestedSessions: count, results });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Session failed.' });
  }
});

app.get('/api/sessions/:runId/status', (request, response) => {
  const run = activeRuns.get(request.params.runId);
  if (!run) return response.status(404).json({ error: 'Run not found.' });
  response.json({ status: run.status, events: run.events.slice(-12) });
});

app.post('/api/sessions/:runId/stop', (request, response) => {
  const run = activeRuns.get(request.params.runId);
  if (!run) return response.status(404).json({ error: 'Run not found.' });
  if (run.stop || run.status === 'Completed') return response.json({ status: run.status });
  run.stop = true;
  run.status = 'Stopping';
  response.status(202).json({ status: run.status });
});

app.listen(port, () => {
  console.log(`AI QA Session Agent running at http://localhost:${port}`);
});
