const form = document.querySelector('#session-form');
const result = document.querySelector('#result');
const button = document.querySelector('#run');
const alertBox = document.querySelector('#alert');
const settingsRoot = document.querySelector('#event-settings');
const probabilityStatus = document.querySelector('#probability-status');
const enableTimeLimit = document.querySelector('#enableTimeLimit');
const maxDurationSeconds = document.querySelector('#maxDurationSeconds');
const useAiPlanner = document.querySelector('#use-ai-planner');
const deviceMode = document.querySelector('#device-mode');
const sessionMode = document.querySelector('#session-mode');
const liveLog = document.querySelector('#live-log');
const liveLogContent = document.querySelector('#live-log-content');
const stopSession = document.querySelector('#stop-session');
const preset = document.querySelector('#preset');
let activeRunId;
let livePoll;
const actionTypes = [
  ['click', 'Click', 20], ['rapid_click', 'Rage Clicks', 20], ['blank_click', 'Dead Clicks', 20], ['type', 'Input Changed', 20], ['thrashed_cursor', 'Thrashed Cursor', 10],
  ['other', 'Other actions', 10]
];

function showAlert(message) {
  alertBox.textContent = message;
  alertBox.hidden = false;
}

function clearAlert() {
  alertBox.hidden = true;
  alertBox.textContent = '';
}

function renderEventSettings() {
  settingsRoot.innerHTML = actionTypes.map(([type, label, defaultWeight]) => `
    <div class="event-row">
      <label class="event-name" for="weight-${type}">${label}</label>
      <input id="weight-${type}" class="weight" data-type="${type}" type="number" min="0" max="100" value="${defaultWeight}" aria-label="${label} probability" />
      <span class="percent">%</span>
      ${type === 'other'
        ? '<label class="required"><input id="enable-other" type="checkbox" checked /> Enable secondary actions</label><p class="event-detail">Popup dismissal, clicks, drag, toggles, dropdowns, keyboard, back/forward, refresh, text selection, and viewport changes.</p>'
        : '<label class="required"><input data-required="' + type + '" type="checkbox" /> Required once</label>' + (type === 'type' ? '<label class="type-text">Text to enter<input id="type-text" type="text" maxlength="500" value="test QA" /></label>' : '')}
    </div>`).join('');
}

function getActionSettings() {
  const weights = Object.fromEntries(actionTypes.map(([type]) => [type, Number(document.querySelector(`#weight-${type}`).value)]));
  if (!document.querySelector('#enable-other').checked) weights.other = 0;
  const required = [...document.querySelectorAll('[data-required]:checked')].map((input) => input.dataset.required);
  return {
    weights,
    required,
    typeText: document.querySelector('#type-text').value,
    useLocalPlanner: !useAiPlanner.checked
  };
}

function syncOtherToggle() {
  const enabled = document.querySelector('#enable-other').checked;
  const weight = document.querySelector('#weight-other');
  weight.disabled = !enabled;
  if (!enabled) weight.value = 0;
}

function validateActionSettings(showMessage = true) {
  const settings = getActionSettings();
  const total = Object.values(settings.weights).reduce((sum, value) => sum + value, 0);
  const requiredAtZero = settings.required.filter((type) => settings.weights[type] === 0);
  const valid = total === 100 && !requiredAtZero.length;
  if (showMessage) {
    probabilityStatus.className = `probability-status ${valid ? 'valid' : 'invalid'}`;
    probabilityStatus.textContent = requiredAtZero.length
      ? `Required event has 0%: ${requiredAtZero.join(', ')}.`
      : `Total: ${total}% ${valid ? '✓' : '(must equal 100%)'}`;
  }
  return valid ? settings : null;
}

renderEventSettings();
syncOtherToggle();
validateActionSettings();
enableTimeLimit.addEventListener('change', () => { maxDurationSeconds.disabled = !enableTimeLimit.checked; });
settingsRoot.addEventListener('input', () => validateActionSettings());
settingsRoot.addEventListener('change', () => {
  syncOtherToggle();
  validateActionSettings();
});
document.querySelector('#reset-events').addEventListener('click', () => {
  renderEventSettings();
  syncOtherToggle();
  validateActionSettings();
});
document.querySelector('#zero-events').addEventListener('click', () => {
  document.querySelectorAll('.weight').forEach((input) => { input.value = 0; });
  document.querySelectorAll('[data-required]').forEach((input) => { input.checked = false; });
  document.querySelector('#enable-other').checked = false;
  syncOtherToggle();
  validateActionSettings();
});

preset.addEventListener('change', () => {
  const presets = {
    natural: { click: 20, rapid_click: 20, blank_click: 20, type: 20, thrashed_cursor: 10, other: 10 },
    aggressive: { click: 25, rapid_click: 30, blank_click: 20, type: 15, thrashed_cursor: 10, other: 0 },
    input: { click: 10, rapid_click: 5, blank_click: 5, type: 60, thrashed_cursor: 5, other: 15 }
  };
  const values = presets[preset.value];
  Object.entries(values).forEach(([type, value]) => { document.querySelector(`#weight-${type}`).value = value; });
  document.querySelector('#enable-other').checked = values.other > 0;
  syncOtherToggle();
  validateActionSettings();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearAlert();
  const actionSettings = validateActionSettings();
  if (!actionSettings) {
    result.hidden = false;
    const message = 'Fix the event probabilities first: the total must equal 100%, and required events cannot be 0%.';
    result.textContent = message;
    showAlert(message);
    return;
  }
  button.disabled = true;
  button.textContent = 'Running…';
  result.hidden = false;
  result.textContent = 'Starting sessions one after another…';
  activeRunId = crypto.randomUUID();
  liveLog.hidden = false;
  liveLogContent.textContent = 'Starting browser session…';
  stopSession.disabled = false;
  try {
    const requestPromise = fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: activeRunId, url: document.querySelector('#url').value, sessionCount: Number(document.querySelector('#sessionCount').value), sessionMode: sessionMode.value, maxSteps: Number(document.querySelector('#maxSteps').value), deviceMode: deviceMode.value, maxDurationSeconds: enableTimeLimit.checked ? Number(maxDurationSeconds.value) : undefined, actionSettings })
    });
    livePoll = setInterval(async () => {
      const status = await fetch(`/api/sessions/${activeRunId}/status`).then((item) => item.ok ? item.json() : null).catch(() => null);
      if (status?.events?.length) liveLogContent.innerHTML = status.events.map((item) => `${item.Result}: ${item.Action}${item.Element !== '—' ? ` — ${item.Element}` : ''}`).join('<br>');
    }, 650);
    const response = await requestPromise;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Session failed.');
    const sessions = data.results.map((item, index) => `<li><strong>Session ${index + 1}</strong>: ${item.session['Session PUUID']} (${item.identifierSource}) — ${item.session.Status}: ${item.session.Summary}</li>`).join('');
    result.innerHTML = `<h2>${data.results.length} session(s) complete</h2><ol class="reports">${sessions}</ol><a class="download" href="${data.results[0].reportUrl}">Download combined Excel report</a>`;
  } catch (error) {
    const message = `Error: ${error.message}`;
    result.textContent = message;
    showAlert(message);
  } finally {
    clearInterval(livePoll);
    stopSession.disabled = true;
    button.disabled = false;
    button.textContent = 'Run session';
  }
});

stopSession.addEventListener('click', async () => {
  if (!activeRunId) return;
  stopSession.disabled = true;
  liveLogContent.textContent = 'Stopping after the current action…';
  await fetch(`/api/sessions/${activeRunId}/stop`, { method: 'POST' });
});
