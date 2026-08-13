"use strict";

const importButton = document.getElementById("variation-import-btn");
const exportButton = document.getElementById("variation-export-btn");
const importFile = document.getElementById("variation-import-file");
const viewerStatus = document.getElementById("viewer-status");
const variationResults = document.getElementById("variation-results");
const plannedScheduleSection = document.getElementById("planned-schedule-section");
const plannedGanttContainer = document.getElementById("planned-gantt-container");
const variationSettingsSection = document.getElementById("variation-settings-section");
const viewerVariationSettings = document.getElementById("viewer-variation-settings");

let inputData = null;

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function topologicalSort(taskList) {
  const ids = taskList.map(task => task.id);
  const idSet = new Set(ids);
  const inDegree = Object.fromEntries(ids.map(id => [id, 0]));
  taskList.forEach(task => task.predecessors.forEach(id => {
    if (idSet.has(id)) inDegree[task.id]++;
  }));
  const queue = ids.filter(id => inDegree[id] === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    taskList.forEach(task => {
      if (task.predecessors.includes(id)) {
        inDegree[task.id]--;
        if (inDegree[task.id] === 0) queue.push(task.id);
      }
    });
  }
  return order.length === taskList.length ? order : null;
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value);
  return element.innerHTML;
}

function validateInput(value) {
  if (!value || value.format !== "cpm-shapley-variations" || !value.project || !Array.isArray(value.project.tasks)) {
    throw new Error("This is not a CPM Shapley variation file.");
  }
  const tasks = value.project.tasks;
  if (!tasks.length) throw new Error("The project has no tasks.");
  if (tasks.length > 10) throw new Error("Variation analysis supports up to 10 tasks.");
  tasks.forEach(task => {
    if (!Number.isFinite(task.plannedDuration) || task.plannedDuration < 0 || !Array.isArray(task.predecessors)) {
      throw new Error(`Task ${task.name || task.id} has invalid schedule data.`);
    }
  });
  if (!topologicalSort(tasks)) throw new Error("The project contains a circular dependency.");
  if (!Array.isArray(value.settings) || value.settings.length !== tasks.length) {
    throw new Error("The variation settings are missing or incomplete.");
  }
  const tasksById = new Map(tasks.map(task => [String(task.id), task]));
  const settingsTaskIds = new Set();
  value.settings.forEach(setting => {
    const settingTaskId = String(setting.taskId);
    const task = tasksById.get(settingTaskId);
    if (!task || settingsTaskIds.has(settingTaskId) ||
        !Number.isFinite(setting.earlyBy) || setting.earlyBy < 0 ||
        setting.earlyBy > task.plannedDuration ||
        !Number.isFinite(setting.lateBy) || setting.lateBy < 0) {
      throw new Error("The variation settings contain invalid early or late values.");
    }
    settingsTaskIds.add(settingTaskId);
  });
  if (value.variations != null && !Array.isArray(value.variations)) {
    throw new Error("The imported variation list is invalid.");
  }
  return value;
}

function displayedVariationCount() {
  return Array.isArray(inputData?.variations)
    ? inputData.variations.length
    : countDistinctVariations(inputData.settings);
}

function loadInput(value, sourceLabel) {
  try {
    inputData = validateInput(value);
  } catch (error) {
    inputData = null;
    exportButton.disabled = true;
    plannedScheduleSection.hidden = true;
    variationSettingsSection.hidden = true;
    variationResults.innerHTML = "";
    viewerStatus.textContent = error.message;
    return;
  }
  const total = displayedVariationCount();
  exportButton.disabled = false;
  plannedScheduleSection.hidden = false;
  variationSettingsSection.hidden = false;
  viewerStatus.textContent = `${sourceLabel}: ${inputData.project.tasks.length} tasks and ${total} variations.`;
  persistLinkedVariationSettings();
  renderPlannedGantt();
  renderVariationSettings();
  renderVariations();
}

function persistLinkedVariationSettings() {
  if (!inputData) return;
  try {
    const storedInput = { ...inputData };
    delete storedInput.variations;
    localStorage.setItem(VARIATION_ANALYSIS_STORAGE_KEY, JSON.stringify(storedInput));
  } catch (error) {
    console.warn("Could not save the variation settings.", error);
  }
  syncSettingsToSchedulerState();
}

function syncSettingsToSchedulerState() {
  let schedulerState;
  try {
    schedulerState = JSON.parse(localStorage.getItem("cpmSchedulerState"));
  } catch {
    return;
  }
  if (!schedulerState ||
      !variationTaskListsMatch(inputData?.project?.tasks, schedulerState.tasks) ||
      !Array.isArray(inputData.settings)) {
    return;
  }

  const offsets = schedulerState.variationOffsets && typeof schedulerState.variationOffsets === "object"
    ? { ...schedulerState.variationOffsets }
    : {};
  inputData.settings.forEach(setting => {
    offsets[setting.taskId] = { early: setting.earlyBy, late: setting.lateBy };
  });
  schedulerState.variationOffsets = offsets;
  try {
    localStorage.setItem("cpmSchedulerState", JSON.stringify(schedulerState));
  } catch (error) {
    console.warn("Could not sync variation settings to the scheduler.", error);
  }
}

function computePlannedSchedule(taskList) {
  const order = topologicalSort(taskList);
  if (!order) return null;
  const nodes = Object.fromEntries(taskList.map(task => [task.id, {
    ...task,
    es: 0,
    ef: 0,
    ls: 0,
    lf: 0,
    float: 0
  }]));

  order.forEach(id => {
    const node = nodes[id];
    node.es = node.predecessors.length
      ? Math.max(...node.predecessors.map(predecessorId => nodes[predecessorId]?.ef || 0))
      : 0;
    node.ef = node.es + node.plannedDuration;
  });
  const projectDuration = Math.max(...Object.values(nodes).map(node => node.ef), 0);

  [...order].reverse().forEach(id => {
    const node = nodes[id];
    const successors = taskList.filter(task => task.predecessors.includes(id));
    node.lf = successors.length
      ? Math.min(...successors.map(successor => nodes[successor.id].ls))
      : projectDuration;
    node.ls = node.lf - node.plannedDuration;
    node.float = round(node.ls - node.es);
  });

  return { nodes: taskList.map(task => nodes[task.id]), projectDuration };
}

function renderPlannedGantt() {
  plannedGanttContainer.innerHTML = "";
  if (!inputData) return;
  const schedule = computePlannedSchedule(inputData.project.tasks);
  if (!schedule) {
    plannedGanttContainer.innerHTML = '<div class="empty-msg">Cannot render: circular dependency.</div>';
    return;
  }

  const CELL_W = 28;
  const ROW_H = 22;
  const HEADER_H = 20;
  const LABEL_W = 110;
  const BAR_MID = 7;
  const maxTime = Math.max(Math.ceil(schedule.projectDuration), 1);
  const wrapper = document.createElement("div");
  wrapper.className = "planned-gantt";
  wrapper.style.position = "relative";

  const header = document.createElement("div");
  header.className = "gantt-header";
  const labelHeader = document.createElement("div");
  labelHeader.className = "gantt-label-header";
  labelHeader.textContent = "Task";
  header.appendChild(labelHeader);
  const timeHeaders = document.createElement("div");
  timeHeaders.className = "gantt-time-headers";
  for (let time = 0; time < maxTime; time++) {
    const cell = document.createElement("div");
    cell.className = "gantt-time-cell";
    cell.textContent = time;
    timeHeaders.appendChild(cell);
  }
  header.appendChild(timeHeaders);
  wrapper.appendChild(header);

  const rowIndex = {};
  schedule.nodes.forEach((node, index) => { rowIndex[node.id] = index; });
  schedule.nodes.forEach(node => {
    const row = document.createElement("div");
    row.className = "gantt-row";
    const label = document.createElement("div");
    label.className = "gantt-row-label";
    label.textContent = node.name;
    label.title = node.name;
    row.appendChild(label);

    const bars = document.createElement("div");
    bars.className = "gantt-row-bars";
    for (let time = 0; time < maxTime; time++) {
      const gridCell = document.createElement("div");
      gridCell.className = "gantt-grid-cell";
      bars.appendChild(gridCell);
    }
    const bar = document.createElement("div");
    bar.className = `gantt-bar planned${node.float === 0 ? " critical" : ""}`;
    bar.style.left = `${node.es * CELL_W}px`;
    bar.style.width = `${Math.max(node.plannedDuration * CELL_W - 2, 1)}px`;
    bar.title = `${node.name} (planned): ${node.es}-${node.ef}`;
    bars.appendChild(bar);
    row.appendChild(bars);
    wrapper.appendChild(row);
  });

  const svgNamespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("width", LABEL_W + maxTime * CELL_W);
  svg.setAttribute("height", HEADER_H + schedule.nodes.length * ROW_H);
  svg.style.position = "absolute";
  svg.style.top = "0";
  svg.style.left = "0";
  svg.style.pointerEvents = "none";
  const defs = document.createElementNS(svgNamespace, "defs");
  const marker = document.createElementNS(svgNamespace, "marker");
  marker.setAttribute("id", "variation-gantt-arrow-planned");
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "10");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "6");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("orient", "auto-start-reverse");
  const arrowHead = document.createElementNS(svgNamespace, "path");
  arrowHead.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  arrowHead.setAttribute("fill", "#666");
  marker.appendChild(arrowHead);
  defs.appendChild(marker);
  svg.appendChild(defs);

  schedule.nodes.forEach(node => {
    node.predecessors.forEach(predecessorId => {
      const predecessor = schedule.nodes.find(item => item.id === predecessorId);
      if (!predecessor) return;
      const x1 = LABEL_W + predecessor.ef * CELL_W;
      const x2 = LABEL_W + node.es * CELL_W;
      const y1 = HEADER_H + rowIndex[predecessorId] * ROW_H + BAR_MID;
      const y2 = HEADER_H + rowIndex[node.id] * ROW_H + BAR_MID;
      const middleX = x1 === x2 ? x1 + 4 : (x1 + x2) / 2;
      const path = document.createElementNS(svgNamespace, "path");
      path.setAttribute("d", `M ${x1} ${y1} L ${middleX} ${y1} L ${middleX} ${y2} L ${x2} ${y2}`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#666");
      path.setAttribute("stroke-width", "1");
      path.setAttribute("marker-end", "url(#variation-gantt-arrow-planned)");
      svg.appendChild(path);
    });
  });

  wrapper.appendChild(svg);
  plannedGanttContainer.appendChild(wrapper);
}

function renderVariationSettings() {
  if (!inputData) return;
  const settings = Object.fromEntries(inputData.settings.map(item => [String(item.taskId), item]));
  const rows = inputData.project.tasks.map(task => {
    const setting = settings[String(task.id)];
    return `<tr><td>${escapeHtml(task.name)}</td><td>${task.plannedDuration}</td>
      <td><input class="viewer-variation-offset" data-task-id="${escapeHtml(task.id)}" data-kind="earlyBy" type="number" min="0" max="${task.plannedDuration}" step="1" value="${setting.earlyBy}"></td>
      <td><input class="viewer-variation-offset" data-task-id="${escapeHtml(task.id)}" data-kind="lateBy" type="number" min="0" step="1" value="${setting.lateBy}"></td></tr>`;
  }).join("");
  viewerVariationSettings.innerHTML = `<table class="analysis-table"><thead><tr><th>Task</th><th>Planned</th><th>Early by</th><th>Late by</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function generatedVariation(index) {
  const settings = Object.fromEntries(inputData.settings.map(item => [item.taskId, item]));
  let encoded = index;
  const outcomes = inputData.project.tasks.map(task => {
    const setting = settings[task.id];
    const states = getDistinctVariationStates(setting);
    const stateIndex = encoded % states.length;
    encoded = Math.floor(encoded / states.length);
    const state = states[stateIndex];
    return {
      taskId: task.id,
      status: state.status,
      deviation: state.deviation,
      actualDuration: task.plannedDuration + state.deviation
    };
  });
  return { id: index + 1, outcomes };
}

function getVariation(index) {
  return Array.isArray(inputData.variations)
    ? inputData.variations[index]
    : generatedVariation(index);
}

function signed(value) {
  return `${value >= 0 ? "+" : ""}${round(value)}`;
}

function renderVariation(index) {
  const variation = getVariation(index);
  const outcomes = Object.fromEntries(variation.outcomes.map(item => [item.taskId, item]));
  const tasks = inputData.project.tasks.map(task => ({
    ...task,
    actualDuration: outcomes[task.id].actualDuration
  }));
  const methods = computeShapleyMethods(tasks, inputData.project.plannedDuration);
  if (!methods) return '<div class="variation-card">Analysis unavailable.</div>';

  const rows = tasks.map((task, taskIndex) => {
    const outcome = outcomes[task.id];
    const projectValue = methods.projectEnd.results[taskIndex].shapleyValue;
    const deviationValue = methods.deviation.results[taskIndex].shapleyValue;
    const rowClass = outcome.deviation > 0 ? "analysis-delay" : outcome.deviation < 0 ? "analysis-accel" : "";
    return `<tr class="${rowClass}"><td>${escapeHtml(task.name)}</td><td>${outcome.status === "onTime" ? "On time" : outcome.status}</td><td>${task.plannedDuration}</td><td>${signed(outcome.deviation)}</td><td>${outcome.actualDuration}</td><td>${signed(projectValue)}</td><td>${signed(deviationValue)}</td></tr>`;
  }).join("");

  return `<section class="variation-card"><h3>Variation ${index + 1}</h3>
    <div class="analysis-summary"><span>Project-end change: <strong>${signed(methods.projectEnd.totalDelay)}</strong></span><span>Most positive deviation: <strong>${signed(methods.deviation.totalDelay)}</strong></span></div>
    <table class="analysis-table"><thead><tr><th>Task</th><th>Outcome</th><th>Planned Duration</th><th>Deviation</th><th>Actual Duration</th><th>Project-End Shapley</th><th>Deviation Shapley</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderVariations() {
  if (!inputData) return;
  const total = displayedVariationCount();
  let html = "";
  for (let index = 0; index < total; index++) html += renderVariation(index);
  variationResults.innerHTML = html;
}

function buildVariationExport() {
  const total = countDistinctVariations(inputData.settings);
  return {
    ...inputData,
    version: inputData.version || 1,
    generatedAt: new Date().toISOString(),
    project: {
      ...inputData.project,
      tasks: inputData.project.tasks.map(task => ({ ...task, predecessors: task.predecessors.slice() }))
    },
    settings: inputData.settings.map(setting => ({ ...setting })),
    variations: Array.from({ length: total }, (_, index) => ({
      ...generatedVariation(index),
      id: index + 1
    }))
  };
}

importButton.addEventListener("click", () => {
  importFile.value = "";
  importFile.click();
});

exportButton.addEventListener("click", () => {
  if (!inputData) return;
  const blob = new Blob([JSON.stringify(buildVariationExport(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "cpm_shapley_variations.json";
  link.click();
  URL.revokeObjectURL(url);
});

importFile.addEventListener("change", () => {
  const file = importFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = event => {
    try {
      loadInput(JSON.parse(event.target.result), file.name);
    } catch {
      viewerStatus.textContent = "The selected file is not valid JSON.";
    }
  };
  reader.readAsText(file);
});

viewerVariationSettings.addEventListener("change", event => {
  const input = event.target.closest(".viewer-variation-offset");
  if (!input || !inputData) return;
  const task = inputData.project.tasks.find(item => String(item.id) === input.dataset.taskId);
  const setting = inputData.settings.find(item => String(item.taskId) === input.dataset.taskId);
  if (!task || !setting) return;

  let value = Number(input.value);
  if (!Number.isFinite(value) || value < 0) value = 0;
  if (input.dataset.kind === "earlyBy") value = Math.min(value, task.plannedDuration);
  setting[input.dataset.kind] = value;
  input.value = value;

  // An imported variation list reflects the old settings. Generate outcomes
  // from the newly edited values from this point onward.
  delete inputData.variations;
  persistLinkedVariationSettings();
  viewerStatus.textContent = `Variation settings updated: ${inputData.project.tasks.length} tasks and ${countDistinctVariations(inputData.settings)} variations.`;
  renderVariations();
});

window.addEventListener("storage", event => {
  if (event.key !== VARIATION_ANALYSIS_STORAGE_KEY || !event.newValue) return;
  try {
    loadInput(JSON.parse(event.newValue), "Updated from scheduler");
  } catch {
    // Ignore invalid state written by another tab.
  }
});

const preloaded = localStorage.getItem(VARIATION_ANALYSIS_STORAGE_KEY);
if (preloaded) {
  try {
    loadInput(JSON.parse(preloaded), "Loaded from scheduler");
  } catch {
    viewerStatus.textContent = "The preloaded scheduler data could not be read.";
  }
}
