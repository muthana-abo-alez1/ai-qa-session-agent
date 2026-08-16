import { chromium } from 'playwright';
import { v4 as uuid } from 'uuid';
import { chooseAction, normalizeActionSettings } from './planner.js';
import { writeReport } from './excel-report.js';

const BLOCKED_TEXT = /delete|remove|sign out|log out|checkout|buy|purchase|pay|submit|confirm|save|create account|register|add to cart|upload|send|share|follow|like/i;
const SENSITIVE_FIELD = /password|email|phone|name|address|card|cvv|otp|verification|security code/i;
const TEXT_SELECTOR = 'p, span, h1, h2, h3, h4, h5, h6, [role="heading"], li, td, [data-testid]';
const POPUP_CLOSE_SELECTOR = 'button[aria-label*="close" i], button[title*="close" i], [role="button"][aria-label*="close" i], [data-dismiss], .close, .modal-close, .popup-close';
const ACTION_LABELS = {
  rapid_click: 'Rage Clicks',
  blank_click: 'Dead Clicks',
  type: 'Input Changed'
};

function assertSafeUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Please enter a valid absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are supported.');
  return parsed;
}

async function inspectPage(page, origin) {
  return page.evaluate(({ origin, blockedPattern, sensitivePattern, textSelector, popupCloseSelector }) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const pageKey = `${location.origin}${location.pathname}${location.search}`;
    const inViewport = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 12 && rect.right > 12 && rect.top < window.innerHeight - 12 && rect.left < window.innerWidth - 12;
    };
    const position = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.max(0, Math.min(window.innerWidth, rect.left + rect.width / 2)), y: Math.max(0, Math.min(window.innerHeight, rect.top + rect.height / 2)) };
    };
    const safe = (href, label) => {
      try {
        const destination = new URL(href, location.href);
        return destination.origin === origin && !new RegExp(blockedPattern, 'i').test(label) && !/^(mailto:|tel:|javascript:)/.test(destination.protocol);
      } catch { return false; }
    };
    const links = [...document.querySelectorAll('a[href]')].map((element, index) => {
      const label = normalize(element.innerText || element.getAttribute('aria-label') || element.href);
      const visible = inViewport(element);
      return { kind: 'link', label, href: element.href, index, candidateId: `link:${element.href}`, ...position(element), safe: visible && safe(element.href, label) };
    }).filter((item) => item.label).slice(0, 30);
    const buttons = [...document.querySelectorAll('button, [role="button"]')].map((element, index) => {
      const label = normalize(element.innerText || element.getAttribute('aria-label'));
      const disabled = element.matches(':disabled, [aria-disabled="true"]');
      const isInsideForm = Boolean(element.closest('form'));
      const visible = inViewport(element);
      return { kind: 'button', label, index, candidateId: `${pageKey}:button:${element.id || element.getAttribute('data-testid') || label}:${index}`, ...position(element), safe: Boolean(label) && !disabled && !isInsideForm && visible && !new RegExp(blockedPattern, 'i').test(label) };
    }).filter((item) => item.label).slice(0, 20);
    const customControls = [...document.querySelectorAll('[onclick], [role="link"], [role="tab"], [role="menuitem"], [data-action]')].map((element, index) => {
      const label = normalize(element.innerText || element.getAttribute('aria-label') || element.getAttribute('title'));
      const disabled = element.matches(':disabled, [aria-disabled="true"]');
      const isInsideForm = Boolean(element.closest('form'));
      const isAlreadyCovered = element.matches('a[href], button, [role="button"]');
      const visible = inViewport(element);
      return { kind: 'custom', label, index, candidateId: `${pageKey}:custom:${element.id || element.getAttribute('data-testid') || label}:${index}`, ...position(element), safe: Boolean(label) && visible && !disabled && !isInsideForm && !isAlreadyCovered && !new RegExp(blockedPattern, 'i').test(label) };
    }).filter((item) => item.label).slice(0, 20);
    const inputs = [...document.querySelectorAll('input, textarea')].map((element, index) => {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      const associatedLabel = normalize(element.labels?.[0]?.innerText);
      const label = normalize(element.getAttribute('aria-label') || element.getAttribute('placeholder') || associatedLabel || element.getAttribute('name') || type);
      const locatorType = element.getAttribute('placeholder') ? 'placeholder' : 'label';
      const disabled = element.matches(':disabled, [aria-disabled="true"]');
      const visible = inViewport(element);
      const excludedType = ['hidden', 'password', 'file', 'checkbox', 'radio', 'submit', 'button', 'reset'].includes(type);
      return { kind: 'input', label, index, candidateId: `${pageKey}:input:${element.id || element.getAttribute('name') || label}:${index}`, locatorType, ...position(element), safe: Boolean(label) && visible && !disabled && !excludedType && !new RegExp(blockedPattern, 'i').test(label) && !new RegExp(sensitivePattern, 'i').test(label) };
    }).filter((item) => item.label).slice(0, 12);
    const toggles = [...document.querySelectorAll('input[type="checkbox"], [role="switch"]')].map((element, index) => {
      const label = normalize(element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.innerText || element.getAttribute('name'));
      const disabled = element.matches(':disabled, [aria-disabled="true"]');
      const visible = inViewport(element);
      const isInsideForm = Boolean(element.closest('form'));
      return { kind: 'toggle', label: label || 'toggle', index, candidateId: `${pageKey}:toggle:${element.id || element.getAttribute('name') || index}`, ...position(element), safe: visible && !disabled && !isInsideForm && !new RegExp(blockedPattern, 'i').test(label) };
    }).slice(0, 12);
    const selects = [...document.querySelectorAll('select')].map((element, index) => {
      const label = normalize(element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.getAttribute('name') || 'select');
      const options = [...element.options].filter((option) => !option.disabled && option.value && !new RegExp(blockedPattern, 'i').test(normalize(option.text))).map((option) => ({ value: option.value, label: normalize(option.text) }));
      const disabled = element.matches(':disabled, [aria-disabled="true"]');
      const visible = inViewport(element);
      const isInsideForm = Boolean(element.closest('form'));
      return { kind: 'select', label, index, options, candidateId: `${pageKey}:select:${element.id || element.getAttribute('name') || index}`, ...position(element), safe: visible && !disabled && !isInsideForm && options.length > 0 && !new RegExp(blockedPattern, 'i').test(label) };
    }).slice(0, 12);
    const popupCandidates = [];
    const possiblePopups = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog, .modal, .popup, .overlay')];
    const activePopup = possiblePopups.find((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return inViewport(element) && style.visibility !== 'hidden' && style.display !== 'none' && rect.width * rect.height > window.innerWidth * window.innerHeight * 0.08;
    });
    if (activePopup) {
      const closeControls = [...document.querySelectorAll(popupCloseSelector)];
      for (const [index, element] of closeControls.entries()) {
        const label = normalize(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || 'Close popup');
        const disabled = element.matches(':disabled, [aria-disabled="true"]');
        if (activePopup.contains(element) && inViewport(element) && !disabled && !new RegExp(blockedPattern, 'i').test(label)) {
          popupCandidates.push({ kind: 'popup_close', label, index, candidateId: `${pageKey}:popup-close:${index}`, ...position(element), safe: true });
        }
      }
    }
    const textTargets = [...document.querySelectorAll(textSelector)].map((element, index) => {
      const label = normalize(element.innerText || element.getAttribute('aria-label') || element.getAttribute('title'));
      const visible = inViewport(element);
      const insideInteractiveControl = Boolean(element.closest('a, button, input, textarea, form, [onclick], [role="button"], [role="link"], [role="tab"], [role="menuitem"]'));
      const hasTextChild = [...element.children].some((child) => normalize(child.innerText) === label);
      const isHeading = element.matches('h1, h2, h3, h4, h5, h6, [role="heading"]');
      return { kind: 'text', label, index, isHeading, candidateId: `${pageKey}:text:${element.id || label.slice(0, 80)}:${index}`, ...position(element), safe: Boolean(label) && label.length <= 180 && visible && !insideInteractiveControl && (isHeading || !hasTextChild) && !new RegExp(blockedPattern, 'i').test(label) };
    }).filter((item) => item.label).slice(0, 40);
    const blankSpots = [];
    for (let y = 120; y < window.innerHeight - 80; y += 140) {
      for (let x = 80; x < window.innerWidth - 80; x += 180) {
        const element = document.elementFromPoint(x, y);
        const overInteractiveControl = Boolean(element?.closest('a, button, input, textarea, select, form, [onclick], [role="button"], [role="link"], [role="tab"], [role="menuitem"]'));
        if (!overInteractiveControl) blankSpots.push({ kind: 'blank', label: `blank area (${x}, ${y})`, x, y, candidateId: `${pageKey}:blank:${x}:${y}`, safe: true });
      }
    }
    const scrollingElement = document.scrollingElement || document.documentElement;
    return {
      title: document.title,
      url: location.href,
      text: normalize(document.body.innerText).slice(0, 3500),
      links,
      buttons,
      customControls,
      textTargets,
      inputs,
      toggles,
      selects,
      dismissiblePopups: popupCandidates,
      blankSpots: blankSpots.slice(0, 20),
      canScrollDown: window.scrollY + window.innerHeight < scrollingElement.scrollHeight - 8,
      canScrollUp: window.scrollY > 8
    };
  }, { origin, blockedPattern: BLOCKED_TEXT.source, sensitivePattern: SENSITIVE_FIELD.source, textSelector: TEXT_SELECTOR, popupCloseSelector: POPUP_CLOSE_SELECTOR });
}

function makeEvent(sessionId, action, url, result, details = '') {
  return {
    'Session PUUID': sessionId,
    Timestamp: new Date().toISOString(),
    Action: ACTION_LABELS[action.type] || action.type,
    Element: action.target || '—',
    URL: url,
    Result: result,
    Details: details
  };
}

function findPuuid(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.puuid === 'string' && value.puuid.trim()) return value.puuid.trim();
  for (const nestedValue of Object.values(value)) {
    const puuid = findPuuid(nestedValue);
    if (puuid) return puuid;
  }
  return undefined;
}

function extractPuuid(request) {
  if (!request.url().includes('event-batch')) return undefined;
  const postData = request.postData();
  if (!postData) return undefined;
  try {
    return findPuuid(JSON.parse(postData));
  } catch {
    return undefined;
  }
}

function isBrowserClosedError(error) {
  return /Target page, context or browser has been closed|browser has been closed|page has been closed/i.test(String(error?.message || error));
}

async function executeAction(page, action, pageState, origin, cursor) {
  if (action.type === 'end') return { stopped: true, details: action.reason };
  if (action.type === 'wait') { await page.waitForTimeout(700); return { details: action.reason }; }
  if (action.type === 'scroll') {
    let pattern;
    try { pattern = JSON.parse(action.value || '{}'); } catch { pattern = {}; }
    const direction = pattern.direction === 'up' ? -1 : 1;
    const steps = Math.min(Math.max(Number(pattern.steps) || 1, 1), 8);
    const distance = Math.min(Math.max(Number(pattern.distance) || 240, 100), 500);
    for (let step = 0; step < steps; step += 1) {
      await page.mouse.wheel(0, direction * (distance * (0.8 + Math.random() * 0.4)));
      if (step < steps - 1) await page.waitForTimeout(100 + Math.floor(Math.random() * 180));
    }
    return { details: action.reason };
  }
  if (action.type === 'scroll_top') { await page.mouse.wheel(0, -(180 + Math.floor(Math.random() * 180))); return { details: action.reason }; }
  if (action.type === 'scroll_random') { await page.mouse.wheel(0, (Math.random() < 0.5 ? -1 : 1) * (120 + Math.floor(Math.random() * 300))); return { details: action.reason }; }
  if (action.type === 'keyboard_tab') { await page.keyboard.press('Tab'); return { details: action.reason }; }
  if (action.type === 'keyboard_shift_tab') { await page.keyboard.press('Shift+Tab'); return { details: action.reason }; }
  if (action.type === 'keyboard_escape') { await page.keyboard.press('Escape'); return { details: action.reason }; }
  if (action.type === 'refresh') { await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }); return { details: action.reason }; }
  if (action.type === 'viewport_mobile') { await page.setViewportSize({ width: 390, height: 844 }); return { details: action.reason }; }
  if (action.type === 'viewport_desktop') { await page.setViewportSize({ width: 1280, height: 800 }); return { details: action.reason }; }
  if (action.type === 'dismiss_popup') {
    const popup = pageState.dismissiblePopups.find((item) => item.safe && item.candidateId === action.candidateId);
    if (!popup) throw new Error('Popup close control is no longer available.');
    const locator = page.locator(POPUP_CLOSE_SELECTOR).nth(popup.index);
    const point = await moveCursorTo(page, locator, cursor);
    await page.mouse.click(point.x, point.y);
    return { details: action.reason };
  }
  if (action.type === 'toggle') {
    const toggle = pageState.toggles.find((item) => item.safe && item.candidateId === action.candidateId);
    if (!toggle) throw new Error('Toggle is no longer available.');
    const locator = page.locator('input[type="checkbox"], [role="switch"]').nth(toggle.index);
    const point = await moveCursorTo(page, locator, cursor);
    await page.mouse.click(point.x, point.y);
    return { details: action.reason };
  }
  if (action.type === 'select_option') {
    const select = pageState.selects.find((item) => item.safe && item.candidateId === action.candidateId);
    if (!select) throw new Error('Select control is no longer available.');
    const option = select.options[Math.floor(Math.random() * select.options.length)];
    const locator = page.locator('select').nth(select.index);
    await moveCursorTo(page, locator, cursor);
    await locator.selectOption(option.value, { timeout: 5000 });
    return { details: `${action.reason} Selected “${option.label}”.` };
  }
  if (action.type === 'focus_blur') {
    const input = pageState.inputs.find((item) => item.safe && item.candidateId === action.candidateId);
    if (!input) throw new Error('Text field is no longer available.');
    const locator = page.locator('input, textarea').nth(input.index);
    const point = await moveCursorTo(page, locator, cursor);
    await page.mouse.click(point.x, point.y);
    await locator.focus();
    await page.waitForTimeout(80 + Math.floor(Math.random() * 180));
    await locator.evaluate((element) => element.blur());
    return { details: action.reason };
  }
  if (action.type === 'blank_click') {
    const spot = pageState.blankSpots.find((item) => item.safe && item.candidateId === action.candidateId);
    if (!spot) throw new Error('Blank click location is no longer available.');
    await moveCursorToPoint(page, cursor, spot.x, spot.y);
    await page.mouse.click(spot.x, spot.y);
    return { details: action.reason };
  }
  if (action.type === 'thrashed_cursor') {
    const spot = pageState.blankSpots.find((item) => item.safe && item.candidateId === action.candidateId);
    if (!spot) throw new Error('Cursor movement location is no longer available.');
    await moveThrashedCursor(page, cursor, spot.x, spot.y);
    return { details: action.reason };
  }
  if (['navigate', 'back', 'forward'].includes(action.type)) {
    if (!pageState.knownPages?.includes(action.target)) throw new Error('Navigation target was not previously visited.');
    const destination = new URL(action.target);
    if (destination.origin !== origin) throw new Error('Cross-origin navigation is blocked.');
    await page.goto(destination.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return { details: action.reason };
  }
  if (action.type === 'type') {
    const input = pageState.inputs.find((item) => item.safe && item.candidateId === action.candidateId);
    if (!input) throw new Error('Planner selected an unsafe or unavailable text field.');
    const locator = page.locator('input, textarea').nth(input.index);
    const point = await moveCursorTo(page, locator, cursor);
    await page.mouse.click(point.x, point.y);
    const value = action.value || 'test QA';
    if (Math.random() < 0.45) {
      await locator.press('Control+A');
      await locator.pressSequentially(value, { delay: 35 + Math.floor(Math.random() * 55) });
    } else {
      await locator.fill(value, { timeout: 5000 });
    }
    return { details: action.reason };
  }
  if (!['click', 'double_click', 'right_click', 'hover', 'hover_click', 'drag', 'rapid_click', 'keyboard_enter', 'select_text'].includes(action.type)) {
    throw new Error(`Unsupported action: ${action.type}`);
  }

  const link = pageState.links.find((item) => item.safe && item.candidateId === action.candidateId);
  const button = pageState.buttons.find((item) => item.safe && item.candidateId === action.candidateId);
  const customControl = pageState.customControls.find((item) => item.safe && item.candidateId === action.candidateId);
  const textTarget = pageState.textTargets.find((item) => item.safe && item.candidateId === action.candidateId);
  if (!link && !button && !customControl && !textTarget) throw new Error('Planner selected an unsafe or unavailable target.');
  let locator;
  if (link) {
    const target = new URL(link.href);
    if (target.origin !== origin) throw new Error('Cross-origin navigation is blocked.');
    locator = page.locator('a[href]').nth(link.index);
  } else if (button) {
    locator = page.locator('button, [role="button"]').nth(button.index);
  } else if (customControl) {
    locator = page.locator('[onclick], [role="link"], [role="tab"], [role="menuitem"], [data-action]').nth(customControl.index);
  } else {
    locator = page.locator(TEXT_SELECTOR).nth(textTarget.index);
  }
  const point = await moveCursorTo(page, locator, cursor);
  if (Math.random() < 0.3 && ['click', 'double_click', 'rapid_click', 'hover_click'].includes(action.type)) {
    await page.waitForTimeout(80 + Math.floor(Math.random() * 220));
  }
  if (action.type === 'double_click') await page.mouse.dblclick(point.x, point.y);
  else if (action.type === 'right_click') await page.mouse.click(point.x, point.y, { button: 'right' });
  else if (action.type === 'hover_click') { await page.waitForTimeout(100 + Math.floor(Math.random() * 200)); await page.mouse.click(point.x, point.y); }
  else if (action.type === 'drag') {
    const box = await locator.boundingBox();
    if (!box) throw new Error('Drag target is no longer visible.');
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + Math.min(90, box.width * 0.35), startY + Math.min(70, box.height * 0.35), { steps: 8 });
    await page.mouse.up();
  }
  else if (action.type === 'rapid_click') {
    const requestedClicks = Number(action.value);
    const clicks = Number.isInteger(requestedClicks) && requestedClicks >= 5 && requestedClicks <= 10
      ? requestedClicks
      : 5 + Math.floor(Math.random() * 6);
    action.value = String(clicks);
    const clickDelay = Math.min(Math.max(Number(process.env.BURST_CLICK_DELAY_MS || 200), 50), 3000);
    for (let click = 0; click < clicks; click += 1) {
      await page.mouse.click(point.x, point.y);
      if (click < clicks - 1) await page.waitForTimeout(clickDelay);
    }
  }
  else if (action.type === 'hover') await page.waitForTimeout(140 + Math.floor(Math.random() * 240));
  else if (action.type === 'keyboard_enter') await locator.press('Enter', { timeout: 5000 });
  else if (action.type === 'select_text') await locator.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  else await locator.click({ timeout: 5000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  return { details: action.reason };
}

async function moveCursorTo(page, locator, cursor) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Target is no longer visible for cursor movement.');
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const left = Math.max(2, box.x + 2);
  const right = Math.min(viewport.width - 2, box.x + box.width - 2);
  const top = Math.max(2, box.y + 2);
  const bottom = Math.min(viewport.height - 2, box.y + box.height - 2);
  if (right <= left || bottom <= top) {
    throw new Error('Target moved outside the viewport; waiting for a natural scroll.');
  }
  const x = left + (right - left) * (0.28 + Math.random() * 0.44);
  const y = top + (bottom - top) * (0.28 + Math.random() * 0.44);
  await moveCursorToPoint(page, cursor, x, y);
  const delay = Math.min(Math.max(Number(process.env.CURSOR_MOVE_DELAY_MS || 350), 0), 3000);
  if (delay) await page.waitForTimeout(delay * (0.65 + Math.random() * 0.7));
  return { x, y };
}

async function moveCursorToPoint(page, cursor, x, y) {
  const travel = Math.min(Math.max(Number(process.env.CURSOR_TRAVEL_MS || 900), 100), 5000);
  const steps = Math.max(8, Math.round(travel / 45));
  const fromX = cursor.x;
  const fromY = cursor.y;
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    await page.mouse.move(fromX + (x - fromX) * progress, fromY + (y - fromY) * progress);
    await page.waitForTimeout(travel / steps);
  }
  cursor.x = x;
  cursor.y = y;
}

async function moveThrashedCursor(page, cursor, x, y) {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const moves = 14 + Math.floor(Math.random() * 12);
  const radius = Math.max(180, Math.min(viewport.width, viewport.height) * (0.35 + Math.random() * 0.3));
  for (let move = 0; move < moves; move += 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 35 + Math.random() * radius;
    const nextX = Math.max(10, Math.min(x + Math.cos(angle) * distance, viewport.width - 10));
    const nextY = Math.max(10, Math.min(y + Math.sin(angle) * distance, viewport.height - 10));
    await page.mouse.move(nextX, nextY);
    await page.waitForTimeout(35 + Math.floor(Math.random() * 55));
    cursor.x = nextX;
    cursor.y = nextY;
  }
}

function createPageSummaries(events, sessionId) {
  const pages = new Map();
  for (const event of events) {
    const page = pages.get(event.URL) ?? { actions: [], failures: 0 };
    page.actions.push(event.Action);
    if (event.Result === 'Failed') page.failures += 1;
    pages.set(event.URL, page);
  }
  return [...pages.entries()].map(([url, page]) => {
    const counts = page.actions.reduce((all, action) => ({ ...all, [action]: (all[action] || 0) + 1 }), {});
    const actions = Object.entries(counts).map(([action, count]) => `${action} ×${count}`).join(', ');
    return {
      'Session PUUID': sessionId,
      URL: url,
      Events: actions,
      'Page Summary': `Performed ${page.actions.length} event(s): ${actions}.${page.failures ? ` ${page.failures} failed.` : ''}`
    };
  });
}

export async function runSession({ url, maxSteps = 8, actionSettings = {}, maxDurationSeconds, deviceMode = 'desktop', replayPlan = [], shouldStop = () => false, onEvent = () => {} }) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';
  const startUrl = assertSafeUrl(url);
  const steps = Math.min(Math.max(Number.isFinite(maxSteps) ? maxSteps : 60, 1), 500);
  const settings = normalizeActionSettings(actionSettings);
  const actionDelay = Math.min(Math.max(Number(process.env.ACTION_DELAY_MS || 1500), 250), 10000);
  const nextActionDelay = () => Math.round(actionDelay * (0.75 + Math.random() * 0.5));
  const sessionId = uuid();
  let puuid;
  const startedAt = new Date();
  let deadline = Number.isFinite(maxDurationSeconds) ? startedAt.getTime() + maxDurationSeconds * 1000 : undefined;
  let timeLimitSource = deadline ? 'session start' : undefined;
  let communicationTimerStarted = false;
  const events = [];
  const addEvent = (event) => { events.push(event); onEvent(event); };
  const issues = [];
  const pageMap = [];
  const history = [];
  const recordedPlan = [];
  const isReplay = Array.isArray(replayPlan) && replayPlan.length > 0;
  const knownPages = new Set([startUrl.href]);
  const visitedPages = [startUrl.href];
  let visitedPageIndex = 0;
  const trackVisitedPage = (value) => {
    if (visitedPages[visitedPageIndex] === value) return;
    const existingIndex = visitedPages.lastIndexOf(value);
    if (existingIndex >= 0) { visitedPageIndex = existingIndex; return; }
    visitedPages.splice(visitedPageIndex + 1);
    visitedPages.push(value);
    visitedPageIndex = visitedPages.length - 1;
  };
  const cursor = { x: 20, y: 20 };
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
  const context = await browser.newContext(deviceMode === 'mobile'
    ? { viewport: { width: 390, height: 844 }, isMobile: true }
    : { viewport: { width: 1280, height: 800 } });
  let closedDuringSession = false;
  let stoppedByUser = false;
  let timeLimitReached = false;
  let expectedShutdown = false;
  let lastKnownUrl = startUrl.href;
  const markBrowserClosed = () => { closedDuringSession = true; };

  let page;
  try {
    page = await context.newPage();
    page.on('close', () => { if (!expectedShutdown) markBrowserClosed(); });
    const captureFirstPuuid = (request) => {
      const capturedPuuid = extractPuuid(request);
      if (capturedPuuid) {
        puuid = capturedPuuid;
        page.off('request', captureFirstPuuid);
      }
    };
    page.on('request', captureFirstPuuid);
    page.on('request', (request) => {
      if (deadline && !communicationTimerStarted && request.url().includes('initiate-communication')) {
        deadline = Date.now() + maxDurationSeconds * 1000;
        timeLimitSource = 'initiate-communication request';
        communicationTimerStarted = true;
      }
    });
    page.on('pageerror', (error) => issues.push({ 'Session PUUID': sessionId, 'Possible Issue': 'Page JavaScript error', Severity: 'medium', Evidence: error.message, URL: page.url() }));
    page.on('requestfailed', (request) => issues.push({ 'Session PUUID': sessionId, 'Possible Issue': 'Network request failed', Severity: 'low', Evidence: request.failure()?.errorText || request.url(), URL: page.url() }));
    await page.goto(startUrl.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    knownPages.add(page.url());
    trackVisitedPage(page.url());
    lastKnownUrl = page.url();
    addEvent(makeEvent(sessionId, { type: 'navigate', target: startUrl.href, candidateId: '' }, page.url(), 'Success', 'Opened target URL.'));

    for (let step = 0; ; step += 1) {
      if (shouldStop()) { stoppedByUser = true; break; }
      const requiredStillMissing = settings.required.filter((type) => !history.some((item) => item.action.type === type));
      if (isReplay && step >= replayPlan.length) break;
      if (deadline && Date.now() >= deadline) {
        timeLimitReached = true;
        break;
      }
      if (!isReplay && step >= steps && !requiredStillMissing.length) break;
      if (page.isClosed() || !browser.isConnected()) {
        markBrowserClosed();
        break;
      }
      let pageState;
      try {
        pageState = await inspectPage(page, startUrl.origin);
      } catch (error) {
        if (page.isClosed() || !browser.isConnected() || isBrowserClosedError(error)) {
          markBrowserClosed();
          break;
        }
        throw error;
      }
      pageState.knownPages = [...knownPages];
      pageState.deviceMode = deviceMode;
      pageState.cursor = { ...cursor };
      pageState.backTarget = visitedPages[visitedPageIndex - 1];
      pageState.forwardTarget = visitedPages[visitedPageIndex + 1];
      // When a time limit is active, try all required events first. Otherwise,
      // they retain the previous behavior of running after the regular step budget.
      const forcedTypes = deadline && requiredStillMissing.length
        ? requiredStillMissing
        : step >= steps ? requiredStillMissing : [];
      const action = isReplay
        ? { ...replayPlan[step] }
        : await chooseAction({ page: pageState, history, actionSettings: settings, forcedTypes });
      const planEntry = !isReplay && action.type !== 'end'
        ? { type: action.type, target: action.target, candidateId: action.candidateId, value: action.value, reason: action.reason }
        : undefined;
      if (planEntry) recordedPlan.push(planEntry);
      try {
        const beforeActionUrl = lastKnownUrl;
        const beforeText = pageState.text;
        const outcome = await executeAction(page, action, pageState, startUrl.origin, cursor);
        lastKnownUrl = page.isClosed() ? lastKnownUrl : page.url();
        addEvent(makeEvent(sessionId, action, lastKnownUrl, 'Success', outcome.details));
        history.push({ action, url: lastKnownUrl, result: 'Success' });
        if (planEntry) planEntry.value = action.value;
        if (beforeActionUrl !== lastKnownUrl) pageMap.push({ 'Session PUUID': sessionId, From: beforeActionUrl, To: lastKnownUrl, Action: action.type });
        if (['click', 'hover_click', 'keyboard_enter'].includes(action.type) && !page.isClosed()) {
          const afterText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => beforeText);
          if (beforeActionUrl === lastKnownUrl && afterText.slice(0, 800) === beforeText.slice(0, 800)) {
            issues.push({ 'Session PUUID': sessionId, 'Possible Issue': 'No visible change after interaction', Severity: 'low', Evidence: `${action.type} on ${action.target}`, URL: lastKnownUrl });
          }
        }
        if (!page.isClosed() && new URL(lastKnownUrl).origin === startUrl.origin) knownPages.add(lastKnownUrl);
        if (!page.isClosed() && new URL(lastKnownUrl).origin === startUrl.origin) trackVisitedPage(lastKnownUrl);
        if (outcome.stopped) break;
        if (page.isClosed() || !browser.isConnected()) {
          markBrowserClosed();
          break;
        }
        try {
          const pauseAfterMs = isReplay
            ? Math.min(Math.max(Number(action.pauseAfterMs) || actionDelay, 250), 10000)
            : nextActionDelay();
          if (planEntry) planEntry.pauseAfterMs = pauseAfterMs;
          await page.waitForTimeout(pauseAfterMs);
        } catch (error) {
          if (page.isClosed() || !browser.isConnected() || isBrowserClosedError(error)) {
            markBrowserClosed();
            break;
          }
          throw error;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Action failed.';
        lastKnownUrl = page.isClosed() ? lastKnownUrl : page.url();
        addEvent(makeEvent(sessionId, action, lastKnownUrl, 'Failed', message));
        issues.push({ 'Session PUUID': sessionId, 'Possible Issue': 'Action failed', Severity: 'medium', Evidence: `${action.type}: ${message}`, URL: lastKnownUrl });
        history.push({ action, url: lastKnownUrl, result: 'Failed' });
        if (planEntry) planEntry.value = action.value;
        if (history.slice(-3).every((item) => item.result === 'Failed')) break;
        if (page.isClosed() || !browser.isConnected() || isBrowserClosedError(error)) {
          markBrowserClosed();
          break;
        }
        const pauseAfterMs = isReplay
          ? Math.min(Math.max(Number(action.pauseAfterMs) || actionDelay, 250), 10000)
          : nextActionDelay();
        if (planEntry) planEntry.pauseAfterMs = pauseAfterMs;
        await page.waitForTimeout(pauseAfterMs).catch((waitError) => {
          if (page.isClosed() || !browser.isConnected() || isBrowserClosedError(waitError)) markBrowserClosed();
          else throw waitError;
        });
        if (closedDuringSession) break;
      }
    }
  } catch (error) {
    if (page?.isClosed() || !browser.isConnected() || isBrowserClosedError(error)) markBrowserClosed();
    else throw error;
  } finally {
    if (page && !page.isClosed()) {
      // This is deliberately the final page-side instruction, including time-limit shutdowns.
      await page.evaluate(() => {
        console.log('FUS.terminate()');
        if (typeof globalThis.FUS?.terminate === 'function') globalThis.FUS.terminate();
      }).catch(() => {});
    }
    const configuredTerminateDelay = Math.min(Math.max(Number(process.env.FUS_TERMINATE_DELAY_MS || 5000), 5000), 15000);
    const terminateDelay = deadline ? Math.min(configuredTerminateDelay, Math.max(0, deadline - Date.now())) : configuredTerminateDelay;
    await new Promise((resolve) => setTimeout(resolve, terminateDelay));
    expectedShutdown = true;
    await browser.close().catch((error) => { if (!isBrowserClosedError(error)) throw error; });
  }

  const endedAt = new Date();
  const reportSessionId = puuid || sessionId;
  events.forEach((event) => { event['Session PUUID'] = reportSessionId; });
  issues.forEach((issue) => { issue['Session PUUID'] = reportSessionId; });
  pageMap.forEach((entry) => { entry['Session PUUID'] = reportSessionId; });
  const failedEvents = events.filter((event) => event.Result === 'Failed').length;
  const session = {
    'Session PUUID': reportSessionId,
    'Start Time': startedAt.toISOString(),
    'End Time': endedAt.toISOString(),
    Duration: `${((endedAt - startedAt) / 1000).toFixed(1)}s`,
    'Total Actions': events.length,
    Errors: failedEvents + issues.length,
    Status: closedDuringSession ? 'Browser closed' : stoppedByUser ? 'Stopped by user' : timeLimitReached ? 'Time limit reached' : 'Completed',
    Summary: `${closedDuringSession ? 'Browser closed safely. ' : ''}${stoppedByUser ? 'Stopped from the live control. ' : ''}${timeLimitReached ? `Stopped at the ${maxDurationSeconds}s session limit (${timeLimitSource}). ` : ''}Explored ${new Set(events.map((event) => event.URL)).size} page(s), completed ${events.filter((event) => event.Result === 'Success').length} event(s), and captured ${issues.length} potential issue(s).${settings.required.length ? ` Required: ${settings.required.join(', ')}.` : ''}`
  };
  const reportIssues = issues.length ? issues : [{ 'Session PUUID': reportSessionId, 'Possible Issue': 'No issues captured', Severity: '—', Evidence: '—', URL: startUrl.href }];
  const pages = createPageSummaries(events, reportSessionId);
  const filename = await writeReport({ session, events, issues: reportIssues, pages, pageMap: pageMap.length ? pageMap : [{ 'Session PUUID': reportSessionId, From: startUrl.href, To: startUrl.href, Action: 'start' }] });
  return { session, events, issues: reportIssues, reportUrl: `/reports/${filename}`, identifierSource: puuid ? 'event-batch puuid' : 'generated UUID fallback', actionPlan: recordedPlan };
}
