// Wires headless.html to scenario runners. Handles:
//   - building the scenario card grid
//   - toggling selection state per scenario
//   - running a single scenario (solo) or the whole selection consecutively
//   - periodic log output to the on-page log panel
//   - early termination of an in-flight run
//   - persisting selection + preferences to localStorage
//
// No sim/AI logic lives here — pure UI glue.

import { SCENARIOS } from './scenarios/index.js';
import { runScenario } from './HeadlessRunner.js';
import { BatchLogger } from '../logging/BatchLogger.js';

const STORAGE_KEY = 'headless.state.v1';

const container = document.getElementById('scenarios');
const status = document.getElementById('status');
const verboseBox = document.getElementById('verboseLog');
const maxTicksInput = document.getElementById('maxTicksOverride');
const snapshotInput = document.getElementById('snapshotOverride');
const stopOnErrorBox = document.getElementById('stopOnError');
const uiLogIntervalInput = document.getElementById('uiLogInterval');
const runSelectedBtn = document.getElementById('runSelected');
const selectAllBtn = document.getElementById('selectAll');
const clearSelectionBtn = document.getElementById('clearSelection');
const terminateRunBtn = document.getElementById('terminateRun');
const savedHint = document.getElementById('savedHint');
const logOutput = document.getElementById('logOutput');
const logResetBtn = document.getElementById('logReset');
const logCopyBtn = document.getElementById('logCopy');

// --- Persistence ----------------------------------------------------------

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    console.warn('[headless] failed to load saved state:', err);
    return null;
  }
}

function saveState() {
  const state = {
    selected: [...selectedIds],
    verbose: verboseBox.checked,
    maxTicks: maxTicksInput.value,
    snapshotEvery: snapshotInput.value,
    stopOnError: stopOnErrorBox.checked,
    uiLogInterval: uiLogIntervalInput.value
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    _flashSaved();
  } catch (err) {
    console.warn('[headless] failed to save state:', err);
  }
}

let _savedFlashTimer = null;
function _flashSaved() {
  savedHint.textContent = 'saved';
  if (_savedFlashTimer) clearTimeout(_savedFlashTimer);
  _savedFlashTimer = setTimeout(() => { savedHint.textContent = ''; }, 800);
}

// --- State ----------------------------------------------------------------

const selectedIds = new Set();
const cardByScenarioId = new Map();
const runSoloBtnByScenarioId = new Map();
const allButtons = []; // every interactive button that should disable during a run

// Set to true while a run is in flight; the Terminate button flips
// `.aborted` on the current run's signal object, which the runner checks at
// each yield point. A fresh signal object is created at the start of every
// run so a stale terminate cannot carry over.
let _isRunning = false;
let _abortSignal = { aborted: false };

// Index into BatchLogger.getHistory() of the next log line that hasn't yet
// been appended to the on-page log panel. Reset by the Reset button.
let _lastLogReadIndex = 0;

// Handle for the periodic log-poll interval. Recreated whenever the run
// starts, the user changes the interval, or the run ends.
let _logPollHandle = null;

// --- Load persisted state (before building cards so initial render is correct)

const saved = loadState();
if (saved) {
  if (Array.isArray(saved.selected)) {
    for (const id of saved.selected) selectedIds.add(id);
  }
  if (typeof saved.verbose === 'boolean') verboseBox.checked = saved.verbose;
  if (typeof saved.maxTicks === 'string') maxTicksInput.value = saved.maxTicks;
  if (typeof saved.snapshotEvery === 'string') snapshotInput.value = saved.snapshotEvery;
  if (typeof saved.stopOnError === 'boolean') stopOnErrorBox.checked = saved.stopOnError;
  if (typeof saved.uiLogInterval === 'string') uiLogIntervalInput.value = saved.uiLogInterval;
}

// --- Build cards ----------------------------------------------------------

for (const scenario of SCENARIOS) {
  const card = document.createElement('div');
  card.className = 'scenario-card';
  card.dataset.scenarioId = scenario.id;

  const head = document.createElement('div');
  head.className = 'card-head';

  const check = document.createElement('span');
  check.className = 'check';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = scenario.name;

  const runSoloBtn = document.createElement('button');
  runSoloBtn.type = 'button';
  runSoloBtn.className = 'runSolo';
  runSoloBtn.textContent = '\u25B6';
  runSoloBtn.title = 'Run this scenario alone';
  runSoloBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    runOne(scenario);
  });

  head.appendChild(check);
  head.appendChild(name);
  head.appendChild(runSoloBtn);

  const desc = document.createElement('div');
  desc.className = 'desc';
  desc.textContent = scenario.description;

  card.appendChild(head);
  card.appendChild(desc);

  card.addEventListener('click', () => {
    toggleSelection(scenario.id);
  });

  container.appendChild(card);
  cardByScenarioId.set(scenario.id, card);
  runSoloBtnByScenarioId.set(scenario.id, runSoloBtn);
  allButtons.push(runSoloBtn);
}

// Terminate is deliberately NOT in allButtons — it needs to be enabled
// exactly when everything else is disabled.
allButtons.push(runSelectedBtn, selectAllBtn, clearSelectionBtn);

// --- Reflect selection in DOM ---------------------------------------------

function toggleSelection(scenarioId) {
  if (selectedIds.has(scenarioId)) {
    selectedIds.delete(scenarioId);
  } else {
    selectedIds.add(scenarioId);
  }
  _refreshSelectionUI();
  saveState();
}

function _refreshSelectionUI() {
  for (const [id, card] of cardByScenarioId) {
    card.classList.toggle('selected', selectedIds.has(id));
  }
  const count = selectedIds.size;
  runSelectedBtn.textContent = `Run Selected (${count})`;
  runSelectedBtn.disabled = count === 0 || _isRunning;
}

// --- UI preference persistence --------------------------------------------

verboseBox.addEventListener('change', saveState);
maxTicksInput.addEventListener('input', saveState);
snapshotInput.addEventListener('input', saveState);
stopOnErrorBox.addEventListener('change', saveState);

uiLogIntervalInput.addEventListener('input', () => {
  saveState();
  // Re-arm the polling timer with the new cadence, if a run is in flight.
  if (_isRunning) _startLogPolling();
});

// --- Bulk actions ---------------------------------------------------------

selectAllBtn.addEventListener('click', () => {
  for (const s of SCENARIOS) selectedIds.add(s.id);
  _refreshSelectionUI();
  saveState();
});

clearSelectionBtn.addEventListener('click', () => {
  selectedIds.clear();
  _refreshSelectionUI();
  saveState();
});

runSelectedBtn.addEventListener('click', () => {
  const ordered = SCENARIOS.filter(s => selectedIds.has(s.id));
  if (ordered.length > 0) runMany(ordered);
});

terminateRunBtn.addEventListener('click', () => {
  if (_isRunning) _abortSignal.aborted = true;
});

// --- Log panel ------------------------------------------------------------

logResetBtn.addEventListener('click', () => {
  BatchLogger.clearHistory();
  BatchLogger.clear();
  _lastLogReadIndex = 0;
  logOutput.textContent = '';
});

logCopyBtn.addEventListener('click', async () => {
  const text = logOutput.textContent;
  try {
    await navigator.clipboard.writeText(text);
    logCopyBtn.textContent = 'Copied!';
    setTimeout(() => { logCopyBtn.textContent = 'Copy'; }, 1200);
  } catch (err) {
    console.warn('[headless] clipboard write failed:', err);
  }
});

function _isLogAtBottom() {
  return logOutput.scrollHeight - logOutput.scrollTop - logOutput.clientHeight < 60;
}

function _appendLogLines(lines) {
  if (lines.length === 0) return;
  const stick = _isLogAtBottom();
  // Text node append is cheaper than `textContent +=` (no re-parse of the
  // whole log) and cheaper than `innerHTML +=` (no HTML parsing at all).
  logOutput.appendChild(document.createTextNode(lines.join('\n') + '\n'));
  if (stick) logOutput.scrollTop = logOutput.scrollHeight;
}

// Drain any new lines from BatchLogger's history into the panel. Safe to
// call at any time; no-op if nothing new has been logged.
function _pollLogs() {
  const history = BatchLogger.getHistory();
  if (history.length <= _lastLogReadIndex) return;
  const newLines = history.slice(_lastLogReadIndex);
  _lastLogReadIndex = history.length;
  _appendLogLines(newLines);
}

function _readLogIntervalSec() {
  const raw = uiLogIntervalInput.value.trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function _startLogPolling() {
  _stopLogPolling();
  const sec = _readLogIntervalSec();
  if (sec <= 0) return;
  _logPollHandle = setInterval(_pollLogs, sec * 1000);
}

function _stopLogPolling() {
  if (_logPollHandle !== null) {
    clearInterval(_logPollHandle);
    _logPollHandle = null;
  }
}

// --- Run orchestration ----------------------------------------------------

function _readOptions(statusPrefix) {
  return {
    verbose: verboseBox.checked,
    maxTicks: _readOptionalInt(maxTicksInput),
    snapshotEvery: _readOptionalInt(snapshotInput),
    abortSignal: _abortSignal,
    onProgress: statusPrefix ? _makeProgressReporter(statusPrefix) : null
  };
}

// Builds a progress callback that rewrites the status line every time the
// runner reports in (roughly every 50ms of wall time). The status prefix is
// captured so multi-scenario runs keep their "[2/5]" marker visible, and
// single runs keep the scenario name.
function _makeProgressReporter(prefix) {
  return ({ ticks, maxTicks, remainingTicks }) => {
    status.textContent = `${prefix} - tick ${ticks}/${maxTicks} (${remainingTicks} remaining)`;
  };
}

function _setRunning(running) {
  _isRunning = running;
  if (running) {
    // Fresh signal for this run — otherwise a prior terminate would carry
    // over and kill the next scenario immediately.
    _abortSignal = { aborted: false };
  }
  for (const b of allButtons) b.disabled = running;
  for (const card of cardByScenarioId.values()) {
    card.classList.toggle('disabled', running);
  }
  terminateRunBtn.disabled = !running;
  if (running) {
    _startLogPolling();
  } else {
    _stopLogPolling();
    // One last drain so the panel is complete before we announce "done".
    _pollLogs();
  }
  if (!running) _refreshSelectionUI();
}

// Run a single scenario. Yields the event loop at every await point, so the
// page paints status updates and processes terminate-button clicks while
// the (long-running) sim ticks happen.
async function runOne(scenario) {
  if (_isRunning) return;
  _setRunning(true);
  const prefix = `Running: ${scenario.name}`;
  status.textContent = `${prefix}...`;

  // Yield once so the status paint lands before we enter the sim loop.
  await new Promise(r => setTimeout(r, 0));

  const opts = _readOptions(prefix);
  const t0 = performance.now();
  let result = null;
  let error = null;
  try {
    result = await runScenario(scenario, opts);
  } catch (err) {
    error = err;
    console.error(`[headless] scenario "${scenario.id}" threw:`, err);
  }
  const ms = (performance.now() - t0).toFixed(0);

  if (error) {
    status.textContent = `ERROR: ${scenario.name} — see console.`;
  } else if (result && result.terminated) {
    status.textContent = `Terminated: ${scenario.name} — ${result.ticks} ticks, ${ms}ms. See log panel.`;
  } else {
    const outcome = result && result.winner ? `${result.winner.toUpperCase()} win` : 'timeout';
    status.textContent =
      `Done: ${scenario.name} — ${result.ticks} ticks, ${outcome}, ${ms}ms. Console has full trace.`;
  }
  _setRunning(false);
}

// Run a list of scenarios one after another. Each scenario's run is
// internally non-blocking (the runner yields), so this outer loop just
// awaits each in sequence.
async function runMany(scenarios) {
  if (_isRunning) return;
  _setRunning(true);

  const stopOnError = stopOnErrorBox.checked;

  let index = 0;
  let firstError = null;
  let terminated = false;

  while (index < scenarios.length) {
    if (_abortSignal.aborted) {
      terminated = true;
      break;
    }

    const scenario = scenarios[index];
    const position = `[${index + 1}/${scenarios.length}]`;
    const prefix = `${position} Running: ${scenario.name}`;
    status.textContent = `${prefix}...`;
    // Yield before the (async) run so the status paints.
    await new Promise(r => setTimeout(r, 0));

    const opts = _readOptions(prefix);
    try {
      const result = await runScenario(scenario, opts);
      if (result && result.terminated) {
        terminated = true;
        break;
      }
    } catch (err) {
      console.error(`[headless] scenario "${scenario.id}" threw:`, err);
      if (!firstError) firstError = scenario;
      if (stopOnError) {
        status.textContent = `${position} ERROR in "${scenario.name}" — stopping. See console.`;
        _setRunning(false);
        return;
      }
    }
    index++;
    // Yield between scenarios so the browser can repaint.
    await new Promise(r => setTimeout(r, 0));
  }

  if (terminated) {
    status.textContent = `Terminated after ${index} of ${scenarios.length} scenarios. See log panel.`;
  } else if (firstError) {
    status.textContent = `Finished ${scenarios.length} scenarios. ERROR in "${firstError.name}" — see console.`;
  } else {
    status.textContent = `Finished all ${scenarios.length} selected scenarios. Console has full traces.`;
  }
  _setRunning(false);
}

// --- Misc -----------------------------------------------------------------

function _readOptionalInt(inputEl) {
  if (!inputEl) return undefined;
  const raw = inputEl.value.trim();
  if (raw === '') return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Initial paint of selection state.
_refreshSelectionUI();