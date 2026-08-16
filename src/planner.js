import OpenAI from 'openai';

export const PRIMARY_ACTION_TYPES = ['click', 'rapid_click', 'blank_click', 'type', 'thrashed_cursor'];
export const SECONDARY_ACTION_TYPES = ['dismiss_popup', 'double_click', 'right_click', 'hover', 'hover_click', 'drag', 'navigate', 'back', 'forward', 'wait', 'toggle', 'select_option', 'keyboard_tab', 'keyboard_shift_tab', 'keyboard_enter', 'keyboard_escape', 'focus_blur', 'refresh', 'select_text', 'viewport_mobile', 'viewport_desktop'];
export const ACTION_TYPES = [...PRIMARY_ACTION_TYPES, ...SECONDARY_ACTION_TYPES];
export const ACTION_WEIGHT_KEYS = [...PRIMARY_ACTION_TYPES, 'other'];
export const DEFAULT_ACTION_WEIGHTS = { click: 20, rapid_click: 20, blank_click: 20, type: 20, thrashed_cursor: 10, other: 10 };

export function normalizeActionSettings(value = {}) {
  const inputWeights = value.weights && typeof value.weights === 'object' ? value.weights : {};
  const required = Array.isArray(value.required) ? value.required : [];
  const weights = Object.fromEntries(PRIMARY_ACTION_TYPES.map((type) => {
      const weight = Number(inputWeights[type]);
      return [type, Number.isFinite(weight) ? Math.min(Math.max(weight, 0), 100) : DEFAULT_ACTION_WEIGHTS[type]];
  }));
  const suppliedOther = Number(inputWeights.other);
  const legacyOther = SECONDARY_ACTION_TYPES.reduce((sum, type) => sum + (Number(inputWeights[type]) || 0), 0);
  weights.other = Number.isFinite(suppliedOther) ? Math.min(Math.max(suppliedOther, 0), 100) : legacyOther || DEFAULT_ACTION_WEIGHTS.other;
  const typeText = typeof value.typeText === 'string' && value.typeText.trim()
    ? value.typeText.trim().slice(0, 500)
    : 'test QA';
  return {
    weights,
    typeText,
    useLocalPlanner: value.useLocalPlanner !== false,
    scrollSettings: { enabled: true, frequency: 'high' },
    required: [...new Set(required.filter((type) => PRIMARY_ACTION_TYPES.includes(type)))]
  };
}

const actionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'target', 'candidateId', 'value', 'reason'],
  properties: {
    type: { type: 'string', enum: ['click', 'double_click', 'right_click', 'hover', 'hover_click', 'drag', 'rapid_click', 'blank_click', 'type', 'scroll', 'scroll_top', 'scroll_random', 'navigate', 'back', 'forward', 'wait', 'dismiss_popup', 'toggle', 'select_option', 'keyboard_tab', 'keyboard_shift_tab', 'keyboard_enter', 'keyboard_escape', 'focus_blur', 'refresh', 'select_text', 'viewport_mobile', 'viewport_desktop', 'thrashed_cursor', 'end'] },
    target: { type: 'string' },
    candidateId: { type: 'string' },
    value: { type: 'string' },
    reason: { type: 'string' }
  }
};

function weightedChoice(choices) {
  const total = choices.reduce((sum, choice) => sum + choice.weight, 0);
  if (!total) return undefined;
  let cursor = Math.random() * total;
  for (const choice of choices) {
    cursor -= choice.weight;
    if (cursor <= 0) return choice;
  }
  return choices.at(-1);
}

function pickNearbyTarget(targets, page, history) {
  const lastCandidateId = history.at(-1)?.action?.candidateId;
  const alternatives = targets.filter((target) => target.candidateId !== lastCandidateId);
  const pool = alternatives.length ? alternatives : targets;
  const cursor = page.cursor ?? { x: 0, y: 0 };
  const total = pool.reduce((sum, target) => {
    const distance = Math.hypot((target.x ?? cursor.x) - cursor.x, (target.y ?? cursor.y) - cursor.y);
    return sum + 1 / (100 + distance);
  }, 0);
  let marker = Math.random() * total;
  for (const target of pool) {
    const distance = Math.hypot((target.x ?? cursor.x) - cursor.x, (target.y ?? cursor.y) - cursor.y);
    marker -= 1 / (100 + distance);
    if (marker <= 0) return target;
  }
  return pool.at(-1);
}

function chooseScrollAction(page, history, settings) {
  if (!page.canScrollDown && !page.canScrollUp) return undefined;
  const chance = 0.32;
  const previousWasScroll = ['scroll', 'scroll_top', 'scroll_random'].includes(history.at(-1)?.action?.type);
  if (Math.random() >= (previousWasScroll ? chance * 0.3 : chance)) return undefined;
  const previousScroll = [...history].reverse().find((item) => item.action.type === 'scroll');
  let previousDirection;
  try { previousDirection = JSON.parse(previousScroll?.action.value || '{}').direction; } catch { previousDirection = undefined; }
  const direction = !page.canScrollUp ? 'down'
    : !page.canScrollDown ? 'up'
    : previousDirection === 'down' && Math.random() < 0.34 ? 'up'
    : previousDirection === 'up' && Math.random() < 0.28 ? 'down'
    : Math.random() < 0.67 ? 'down' : 'up';
  const pattern = Math.random() < 0.55 ? 'short' : Math.random() < 0.82 ? 'browse' : 'travel';
  const steps = pattern === 'short' ? 1 : pattern === 'browse' ? 2 + Math.floor(Math.random() * 3) : 5 + Math.floor(Math.random() * 4);
  const distance = pattern === 'short' ? 130 + Math.floor(Math.random() * 220) : pattern === 'browse' ? 180 + Math.floor(Math.random() * 200) : 230 + Math.floor(Math.random() * 220);
  return { type: 'scroll', target: '', candidateId: `scroll:${history.length + 1}`, value: JSON.stringify({ direction, steps, distance }), reason: `Natural ${pattern} scroll ${direction} in ${steps} gradual move(s).` };
}

function chooseDismissAction(page) {
  const target = (page.dismissiblePopups ?? []).find((item) => item.safe);
  return target ? { type: 'dismiss_popup', target: target.label, candidateId: target.candidateId, value: '', reason: 'Dismiss a visible blocking popup before interacting with the page.' } : undefined;
}

function fallbackAction(page, history, settings, forcedTypes = []) {
  const dismissAction = chooseDismissAction(page);
  if (dismissAction) return dismissAction;
  if (!forcedTypes.length) {
    const scrollAction = chooseScrollAction(page, history, settings);
    if (scrollAction) return scrollAction;
  }
  const attemptedEvents = new Set(
    history
      .filter((item) => item.action.candidateId)
      .map((item) => `${item.action.type}:${item.action.candidateId}`)
  );
  const scrolls = history.filter((item) => item.action.type === 'scroll' && item.result === 'Success').length;
  const waits = history.filter((item) => item.action.type === 'wait' && item.result === 'Success').length;
  const interactionCandidates = [...page.links, ...(page.buttons ?? []), ...(page.customControls ?? []), ...(page.textTargets ?? [])]
    .filter((item) => item.safe);
  const inputCandidates = (page.inputs ?? []).filter((item) => item.safe && !attemptedEvents.has(`type:${item.candidateId}`));
  const toggleCandidates = (page.toggles ?? []).filter((item) => item.safe && !attemptedEvents.has(`toggle:${item.candidateId}`));
  const selectCandidates = (page.selects ?? []).filter((item) => item.safe && !attemptedEvents.has(`select_option:${item.candidateId}`));
  const blankCandidates = (page.blankSpots ?? []).filter((item) => item.safe && !attemptedEvents.has(`blank_click:${item.candidateId}`));
  const cursorCandidates = (page.blankSpots ?? []).filter((item) => item.safe && !attemptedEvents.has(`thrashed_cursor:${item.candidateId}`));
  const returnablePages = (page.knownPages ?? []).filter((url) => url !== page.url && !attemptedEvents.has(`navigate:page:${url}`));
  const choices = [];
  const otherChoices = [];
  const allow = (type) => !forcedTypes.length || forcedTypes.includes(type);
  for (const type of ['click', 'rapid_click']) {
    const targets = interactionCandidates.filter((item) => !attemptedEvents.has(`${type}:${item.candidateId}`));
    if (targets.length && allow(type)) choices.push({ type, targets, weight: settings.weights[type] });
  }
  if (inputCandidates.length && allow('type')) choices.push({ type: 'type', targets: inputCandidates, weight: settings.weights.type });
  if (blankCandidates.length && allow('blank_click')) choices.push({ type: 'blank_click', targets: blankCandidates, weight: settings.weights.blank_click });
  if (cursorCandidates.length && allow('thrashed_cursor')) choices.push({ type: 'thrashed_cursor', targets: cursorCandidates, weight: settings.weights.thrashed_cursor });
  for (const type of ['double_click', 'right_click', 'hover', 'hover_click', 'drag', 'keyboard_enter']) {
    const targets = interactionCandidates.filter((item) => !attemptedEvents.has(`${type}:${item.candidateId}`));
    if (targets.length && allow(type)) otherChoices.push({ type, targets });
  }
  if (returnablePages.length && allow('navigate')) otherChoices.push({ type: 'navigate', targets: returnablePages });
  if (page.backTarget && allow('back')) otherChoices.push({ type: 'back', targets: [page.backTarget] });
  if (page.forwardTarget && allow('forward')) otherChoices.push({ type: 'forward', targets: [page.forwardTarget] });
  if (waits < 6 && allow('wait')) otherChoices.push({ type: 'wait' });
  if (toggleCandidates.length && allow('toggle')) otherChoices.push({ type: 'toggle', targets: toggleCandidates });
  if (selectCandidates.length && allow('select_option')) otherChoices.push({ type: 'select_option', targets: selectCandidates });
  if (inputCandidates.length && allow('focus_blur')) otherChoices.push({ type: 'focus_blur', targets: inputCandidates });
  const selectableText = (page.textTargets ?? []).filter((item) => item.safe && !attemptedEvents.has(`select_text:${item.candidateId}`));
  if (selectableText.length && allow('select_text')) otherChoices.push({ type: 'select_text', targets: selectableText });
  if (allow('keyboard_tab')) otherChoices.push({ type: 'keyboard_tab' });
  if (allow('keyboard_shift_tab')) otherChoices.push({ type: 'keyboard_shift_tab' });
  if (allow('keyboard_escape')) otherChoices.push({ type: 'keyboard_escape' });
  if (allow('refresh')) otherChoices.push({ type: 'refresh' });
  if (page.deviceMode === 'mixed' && allow('viewport_mobile')) otherChoices.push({ type: 'viewport_mobile' });
  if (page.deviceMode === 'mixed' && allow('viewport_desktop')) otherChoices.push({ type: 'viewport_desktop' });
  if (otherChoices.length && !forcedTypes.length) choices.push({ type: 'other', targets: otherChoices, weight: settings.weights.other });

  const weightedChoices = choices.filter((choice) => choice.weight > 0);
  if (weightedChoices.length) {
    let choice = weightedChoice(weightedChoices);
    if (choice.type === 'other') choice = choice.targets[Math.floor(Math.random() * choice.targets.length)];
    if (choice.type === 'scroll') return { type: 'scroll', target: '', candidateId: `scroll:${scrolls + 1}`, value: '', reason: 'Scroll gradually to reveal nearby controls.' };
    if (choice.type === 'scroll_top') return { type: 'scroll_top', target: '', candidateId: `scroll_top:${scrolls + 1}`, value: '', reason: 'Return to the top of the page.' };
    if (choice.type === 'scroll_random') return { type: 'scroll_random', target: '', candidateId: `scroll_random:${scrolls + 1}`, value: '', reason: 'Explore a random scroll direction.' };
    if (choice.type === 'wait') return { type: 'wait', target: '', candidateId: `wait:${waits + 1}`, value: '', reason: 'Wait briefly for dynamic page content.' };
    if (['keyboard_tab', 'keyboard_shift_tab', 'keyboard_escape', 'refresh', 'viewport_mobile', 'viewport_desktop'].includes(choice.type)) return { type: choice.type, target: '', candidateId: `${choice.type}:${history.length + 1}`, value: '', reason: 'Run a safe secondary browser interaction.' };
    const selected = pickNearbyTarget(choice.targets, page, history);
    if (['navigate', 'back', 'forward'].includes(choice.type)) return { type: choice.type, target: selected, candidateId: `page:${selected}`, value: '', reason: choice.type === 'navigate' ? 'Return to a previously visited page and inspect its DOM again.' : `Move ${choice.type} within the recorded same-origin session history.` };
    if (choice.type === 'type') return { type: 'type', target: selected.label, candidateId: selected.candidateId, value: settings.typeText, reason: 'Try an unvisited safe text field without submitting.' };
    return { type: choice.type, target: selected.label, candidateId: selected.candidateId, value: '', reason: 'Run a weighted random event on a safe DOM target.' };
  }

  return { type: 'end', target: '', candidateId: '', value: '', reason: forcedTypes.length ? `Required event types are unavailable here: ${forcedTypes.join(', ')}.` : 'No available event has a positive probability.' };
}

export async function chooseAction({ page, history, actionSettings = {}, forcedTypes = [] }) {
  const settings = normalizeActionSettings(actionSettings);
  const dismissAction = chooseDismissAction(page);
  if (dismissAction) return dismissAction;
  if (!forcedTypes.length && actionSettings.useLocalPlanner === false) {
    const scrollAction = chooseScrollAction(page, history, settings);
    if (scrollAction) return scrollAction;
  }
  // Custom weights and required events need deterministic local control, not an AI guess.
  if (forcedTypes.length || actionSettings.useLocalPlanner !== false || !process.env.OPENAI_API_KEY) return fallbackAction(page, history, settings, forcedTypes);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
    instructions: `You are a cautious exploratory QA planner. Choose one varied next action only and avoid selecting the same candidateId twice. Never submit a form, sign in, create an account, buy anything, download anything, delete or modify user data, or leave the current origin. Type only the configured harmless test text into targets marked safe in the inputs list; never submit. Mix clicks, typing, and scrolling when useful. When no safe next action exists, return end.`,
    input: JSON.stringify({ page, history }),
    text: {
      format: {
        type: 'json_schema',
        name: 'qa_action',
        strict: true,
        schema: actionSchema
      }
    }
  });

  try {
    return JSON.parse(response.output_text);
  } catch {
    return { type: 'end', target: '', candidateId: '', value: '', reason: 'The planner did not return a valid action.' };
  }
}
