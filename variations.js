"use strict";

const importButton = document.getElementById("variation-import-btn");
const importFile = document.getElementById("variation-import-file");
const viewerStatus = document.getElementById("viewer-status");
const viewerControls = document.getElementById("viewer-controls");
const variationNumber = document.getElementById("variation-number");
const pageSizeSelect = document.getElementById("page-size");
const previousPage = document.getElementById("previous-page");
const nextPage = document.getElementById("next-page");
const pageLabel = document.getElementById("page-label");
const variationResults = document.getElementById("variation-results");

let inputData = null;
let currentPage = 0;

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
  if (value.variations && value.variations.length !== 3 ** tasks.length) {
    throw new Error("The exported variation list is incomplete.");
  }
  return value;
}

function loadInput(value, sourceLabel) {
  try {
    inputData = validateInput(value);
  } catch (error) {
    inputData = null;
    viewerControls.hidden = true;
    variationResults.innerHTML = "";
    viewerStatus.textContent = error.message;
    return;
  }
  currentPage = 0;
  const total = 3 ** inputData.project.tasks.length;
  variationNumber.max = total;
  variationNumber.value = 1;
  viewerControls.hidden = false;
  viewerStatus.textContent = `${sourceLabel}: ${inputData.project.tasks.length} tasks and ${total} variations.`;
  renderPage();
}

function generatedVariation(index) {
  const settings = Object.fromEntries(inputData.settings.map(item => [item.taskId, item]));
  let encoded = index;
  const outcomes = inputData.project.tasks.map(task => {
    const stateIndex = encoded % 3;
    encoded = Math.floor(encoded / 3);
    const setting = settings[task.id];
    const states = [
      { status: "early", deviation: -setting.earlyBy },
      { status: "onTime", deviation: 0 },
      { status: "delayed", deviation: setting.lateBy }
    ];
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
  return inputData.variations ? inputData.variations[index] : generatedVariation(index);
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
    return `<tr class="${rowClass}"><td>${escapeHtml(task.name)}</td><td>${outcome.status === "onTime" ? "On time" : outcome.status}</td><td>${signed(outcome.deviation)}</td><td>${outcome.actualDuration}</td><td>${signed(projectValue)}</td><td>${signed(deviationValue)}</td></tr>`;
  }).join("");

  return `<section class="variation-card"><h3>Variation ${index + 1}</h3>
    <div class="analysis-summary"><span>Project-end change: <strong>${signed(methods.projectEnd.totalDelay)}</strong></span><span>Most positive deviation: <strong>${signed(methods.deviation.totalDelay)}</strong></span></div>
    <table class="analysis-table"><thead><tr><th>Task</th><th>Outcome</th><th>Deviation</th><th>Actual</th><th>Project-End Shapley</th><th>Deviation Shapley</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderPage() {
  if (!inputData) return;
  const total = 3 ** inputData.project.tasks.length;
  const pageSize = Number(pageSizeSelect.value);
  const totalPages = Math.ceil(total / pageSize);
  currentPage = Math.max(0, Math.min(currentPage, totalPages - 1));
  const start = currentPage * pageSize;
  const end = Math.min(start + pageSize, total);
  let html = "";
  for (let index = start; index < end; index++) html += renderVariation(index);
  variationResults.innerHTML = html;
  variationNumber.value = start + 1;
  pageLabel.textContent = `Showing ${start + 1}–${end} of ${total}`;
  previousPage.disabled = currentPage === 0;
  nextPage.disabled = currentPage === totalPages - 1;
}

importButton.addEventListener("click", () => {
  importFile.value = "";
  importFile.click();
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

previousPage.addEventListener("click", () => { currentPage--; renderPage(); });
nextPage.addEventListener("click", () => { currentPage++; renderPage(); });
pageSizeSelect.addEventListener("change", () => { currentPage = 0; renderPage(); });
variationNumber.addEventListener("change", () => {
  const total = 3 ** inputData.project.tasks.length;
  const selected = Math.max(1, Math.min(total, Number(variationNumber.value) || 1));
  currentPage = Math.floor((selected - 1) / Number(pageSizeSelect.value));
  renderPage();
});

const preloaded = localStorage.getItem("cpmVariationAnalysisInput");
if (preloaded) {
  try {
    loadInput(JSON.parse(preloaded), "Loaded from scheduler");
  } catch {
    viewerStatus.textContent = "The preloaded scheduler data could not be read.";
  }
}
