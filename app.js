"use strict";

// ── State ──────────────────────────────────────────────────────────
let tasks = [];
let nextId = 1;
let editingTaskId = null;
let ganttOrder = [];
let variationOffsets = {};

// ── DOM refs ───────────────────────────────────────────────────────
const taskNameInput = document.getElementById("task-name");
const plannedDurInput = document.getElementById("planned-dur");
const predecessorSelect = document.getElementById("predecessors-container");
const addBtn = document.getElementById("add-btn");
const scheduleBody = document.getElementById("schedule-body");
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");
const statusTasks = document.getElementById("status-tasks");
const statusDuration = document.getElementById("status-duration");
const statusCritical = document.getElementById("status-critical");
const ganttContainer = document.getElementById("gantt-container");
const ganttEmpty = document.getElementById("gantt-empty");
const togglePlanned = document.getElementById("toggle-planned");
const toggleActual = document.getElementById("toggle-actual");
const toggleRelations = document.getElementById("toggle-relations");
const analysisBtn = document.getElementById("analysis-btn");
const analysisStatus = document.getElementById("analysis-status");
const analysisResults = document.getElementById("analysis-results");
const variationSettings = document.getElementById("variation-settings");
const variationExportBtn = document.getElementById("variation-export-btn");
const variationOpenBtn = document.getElementById("variation-open-btn");
const variationStatus = document.getElementById("variation-status");
const MAX_VARIATION_TASKS = 10;
const SCHEDULER_STORAGE_KEY = "cpmSchedulerState";

function persistSchedulerState() {
  const state = {
    version: 1,
    tasks,
    nextId,
    ganttOrder,
    variationOffsets,
    display: {
      planned: togglePlanned.checked,
      actual: toggleActual.checked,
      relations: toggleRelations.checked
    }
  };
  try {
    localStorage.setItem(SCHEDULER_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("Could not save the scheduler state.", error);
  }
}

function restoreSchedulerState() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(SCHEDULER_STORAGE_KEY));
  } catch {
    return;
  }
  if (!saved || !Array.isArray(saved.tasks)) return;

  tasks = saved.tasks.map(task => ({
    id: task.id,
    name: task.name,
    plannedDuration: task.plannedDuration,
    actualDuration: Number.isFinite(task.actualDuration) ? task.actualDuration : null,
    predecessors: Array.isArray(task.predecessors) ? task.predecessors.slice() : []
  }));
  const taskIds = new Set(tasks.map(task => task.id));
  const savedOrder = Array.isArray(saved.ganttOrder)
    ? saved.ganttOrder.filter(id => taskIds.has(id))
    : [];
  ganttOrder = savedOrder.concat(tasks.map(task => task.id).filter(id => !savedOrder.includes(id)));
  nextId = Math.max(Number(saved.nextId) || 1, ...tasks.map(task => task.id + 1), 1);
  variationOffsets = saved.variationOffsets && typeof saved.variationOffsets === "object"
    ? saved.variationOffsets
    : {};
  syncVariationOffsetsFromAnalysis();

  if (saved.display) {
    togglePlanned.checked = saved.display.planned !== false;
    toggleActual.checked = saved.display.actual !== false;
    toggleRelations.checked = saved.display.relations !== false;
  }
}

// ── Toggle Event Listeners ─────────────────────────────────────────
togglePlanned.addEventListener("change", () => render());
toggleActual.addEventListener("change", () => render());
toggleRelations.addEventListener("change", () => render());

// ── Run Analysis ───────────────────────────────────────────────────
analysisBtn.addEventListener("click", () => {
  const cpm = computeCPM();
  if (cpm.hasCycle) {
    analysisStatus.textContent = "Cannot analyse: circular dependency.";
    return;
  }
  renderAnalysis(cpm.projectDuration);
});

// ── Add Task ───────────────────────────────────────────────────────
addBtn.addEventListener("click", () => {
  const name = taskNameInput.value.trim();
  const dur = parseInt(plannedDurInput.value, 10);

  if (!name) { alert("Enter a task name."); return; }
  if (isNaN(dur) || dur < 1) { alert("Enter a valid duration (≥ 1)."); return; }
  if (tasks.some(t => t.name === name)) { alert("Task name must be unique."); return; }

  // Gather selected predecessors from checkboxes
  const preds = [];
  const checkedBoxes = predecessorSelect.querySelectorAll('input[type="checkbox"]:checked');
  checkedBoxes.forEach(cb => {
    preds.push(parseInt(cb.value, 10));
  });

  const newTask = {
    id: nextId++,
    name,
    plannedDuration: dur,
    actualDuration: null,
    predecessors: preds
  };
  tasks.push(newTask);
  ganttOrder.push(newTask.id);

  taskNameInput.value = "";
  plannedDurInput.value = "";
  render();
});

// ── Delete Task ────────────────────────────────────────────────────
function deleteTask(id) {
  if (editingTaskId === id) editingTaskId = null;
  // Remove from all predecessor lists first
  tasks.forEach(t => {
    t.predecessors = t.predecessors.filter(pid => pid !== id);
  });
  tasks = tasks.filter(t => t.id !== id);
  ganttOrder = ganttOrder.filter(pid => pid !== id);
  render();
}

// ── Set Actual Duration ────────────────────────────────────────────
function setActual(id, value) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const v = parseInt(value, 10);
  task.actualDuration = (isNaN(v) || v < 0) ? null : v;
  render();
}

function syncVariationOffsetsFromAnalysis(value) {
  let analysisInput = value;
  if (!analysisInput) {
    try {
      analysisInput = JSON.parse(localStorage.getItem(VARIATION_ANALYSIS_STORAGE_KEY));
    } catch {
      return false;
    }
  }
  if (!analysisInput?.project ||
      !variationTaskListsMatch(tasks, analysisInput.project.tasks) ||
      !Array.isArray(analysisInput.settings)) {
    return false;
  }

  const settingsById = new Map(analysisInput.settings.map(setting => [String(setting.taskId), setting]));
  const syncedOffsets = { ...variationOffsets };
  for (const task of tasks) {
    const setting = settingsById.get(String(task.id));
    if (!setting || !Number.isFinite(setting.earlyBy) || setting.earlyBy < 0 ||
        !Number.isFinite(setting.lateBy) || setting.lateBy < 0) {
      return false;
    }
    syncedOffsets[task.id] = {
      early: Math.min(setting.earlyBy, task.plannedDuration),
      late: setting.lateBy
    };
  }
  variationOffsets = syncedOffsets;
  return true;
}

function setPlannedDuration(id, value) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const duration = parseInt(value, 10);
  if (isNaN(duration) || duration < 1) {
    alert("Enter a valid duration (at least 1).");
    render();
    return;
  }

  task.plannedDuration = duration;
  if (variationOffsets[id]) {
    variationOffsets[id].early = Math.min(variationOffsets[id].early, duration);
  }
  render();
}

function setPredecessor(taskId, predecessorId, isSelected) {
  const task = tasks.find(item => item.id === taskId);
  if (!task || taskId === predecessorId) return;
  const previousPredecessors = task.predecessors.slice();

  if (isSelected) {
    if (!task.predecessors.includes(predecessorId)) task.predecessors.push(predecessorId);
  } else {
    task.predecessors = task.predecessors.filter(id => id !== predecessorId);
  }

  if (!topologicalSort(tasks)) {
    task.predecessors = previousPredecessors;
    alert("Cannot update predecessors: this change would introduce a circular dependency.");
  }
  render();
}

// ── Topological Sort (cycle check helper) ──────────────────────────
// Returns an array of task ids in dependency order, or null if the
// predecessor graph contains a cycle.
function topologicalSort(taskList) {
  const ids = taskList.map(t => t.id);
  const idSet = new Set(ids);

  const inDeg = {};
  ids.forEach(id => { inDeg[id] = 0; });
  taskList.forEach(t => {
    t.predecessors.forEach(pid => {
      if (idSet.has(pid)) inDeg[t.id]++;
    });
  });

  const queue = [];
  ids.forEach(id => { if (inDeg[id] === 0) queue.push(id); });

  const sorted = [];
  while (queue.length) {
    const id = queue.shift();
    sorted.push(id);
    taskList.forEach(t => {
      if (t.predecessors.includes(id)) {
        inDeg[t.id]--;
        if (inDeg[t.id] === 0) queue.push(t.id);
      }
    });
  }

  return sorted.length === taskList.length ? sorted : null;
}

// ── CPM Forward & Backward Pass ────────────────────────────────────
function computeCPM() {
  // Build lookup
  const map = {};
  tasks.forEach(t => {
    map[t.id] = {
      ...t,
      es: 0, ef: 0, ls: 0, lf: 0, float: 0
    };
  });

  // Topological sort (Kahn's algorithm)
  const inDeg = {};
  tasks.forEach(t => { inDeg[t.id] = 0; });
  tasks.forEach(t => {
    t.predecessors.forEach(pid => {
      if (map[pid]) inDeg[t.id]++;
    });
  });

  const queue = [];
  tasks.forEach(t => { if (inDeg[t.id] === 0) queue.push(t.id); });
  const sorted = [];
  while (queue.length) {
    const id = queue.shift();
    sorted.push(id);
    tasks.forEach(t => {
      if (t.predecessors.includes(id)) {
        inDeg[t.id]--;
        if (inDeg[t.id] === 0) queue.push(t.id);
      }
    });
  }

  if (sorted.length !== tasks.length) {
    // Cycle detected – skip computation
    return { nodes: tasks.map(t => map[t.id]), projectDuration: 0, hasCycle: true };
  }

  // Forward pass
  sorted.forEach(id => {
    const node = map[id];
    if (node.predecessors.length === 0) {
      node.es = 0;
    } else {
      node.es = Math.max(...node.predecessors.map(pid => map[pid] ? map[pid].ef : 0));
    }
    node.ef = node.es + node.plannedDuration;
  });

  const projectDuration = Math.max(...Object.values(map).map(n => n.ef), 0);

  // Backward pass
  sorted.slice().reverse().forEach(id => {
    const node = map[id];
    // Find successors
    const succs = tasks.filter(t => t.predecessors.includes(id));
    if (succs.length === 0) {
      node.lf = projectDuration;
    } else {
      node.lf = Math.min(...succs.map(s => map[s.id].ls));
    }
    node.ls = node.lf - node.plannedDuration;
    node.float = node.ls - node.es;
  });

  return { nodes: tasks.map(t => map[t.id]), projectDuration, hasCycle: false };
}

// ── Compute actual project duration ────────────────────────────────
function computeActualDuration() {
  // Only computable when all tasks have actual durations
  if (tasks.length === 0) return null;
  if (tasks.some(t => t.actualDuration === null)) return null;

  const map = {};
  tasks.forEach(t => { map[t.id] = { ...t, ef: 0 }; });

  // Use same topo order
  const inDeg = {};
  tasks.forEach(t => { inDeg[t.id] = 0; });
  tasks.forEach(t => {
    t.predecessors.forEach(pid => { if (map[pid]) inDeg[t.id]++; });
  });
  const queue = [];
  tasks.forEach(t => { if (inDeg[t.id] === 0) queue.push(t.id); });
  const sorted = [];
  while (queue.length) {
    const id = queue.shift();
    sorted.push(id);
    tasks.forEach(t => {
      if (t.predecessors.includes(id)) {
        inDeg[t.id]--;
        if (inDeg[t.id] === 0) queue.push(t.id);
      }
    });
  }

  if (sorted.length !== tasks.length) return null;

  sorted.forEach(id => {
    const node = map[id];
    let es = 0;
    if (node.predecessors.length > 0) {
      es = Math.max(...node.predecessors.map(pid => map[pid] ? map[pid].ef : 0));
    }
    node.ef = es + node.actualDuration;
  });

  return Math.max(...Object.values(map).map(n => n.ef), 0);
}

// ── Render ─────────────────────────────────────────────────────────
function render() {
  // Update predecessor dropdown checkboxes
  predecessorSelect.innerHTML = "";
  if (tasks.length === 0) {
    predecessorSelect.innerHTML = '<span style="color: #999; font-style: italic; font-size: 11px; padding: 2px;">No tasks available</span>';
  } else {
    tasks.forEach(t => {
      const label = document.createElement("label");
      label.innerHTML = `<input type="checkbox" value="${t.id}"> ${t.name}`;
      predecessorSelect.appendChild(label);
    });
  }

  // Compute CPM
  const cpm = computeCPM();

  // Render table
  if (tasks.length === 0) {
    scheduleBody.innerHTML = '<tr><td colspan="11" class="empty-msg">No tasks added.</td></tr>';
  } else {
    scheduleBody.innerHTML = "";
    if (cpm.hasCycle) {
      const warningRow = document.createElement("tr");
      warningRow.innerHTML = `
        <td colspan="11" style="background: #ffe0e0; color: #a03030; font-weight: 600; text-align: center; border: 1px solid #c06060;">
          ⚠️ Circular dependency detected! Please edit predecessors to resolve.
        </td>
      `;
      scheduleBody.appendChild(warningRow);
    }

    cpm.nodes.forEach((node, index) => {
      const tr = document.createElement("tr");
      if (node.float === 0 && !cpm.hasCycle) tr.className = "critical";

      // Drag and drop event listeners
      tr.draggable = false;
      tr.addEventListener("dragstart", (e) => {
        handleDragStart(e, index);
      });
      tr.addEventListener("dragover", handleDragOver);
      tr.addEventListener("drop", (e) => handleDrop(e, index));
      tr.addEventListener("dragend", (e) => {
        tr.draggable = false;
        handleDragEnd(e);
      });

      const isEditing = node.id === editingTaskId;

      const inlinePredecessorCheckboxes = tasks
        .filter(task => task.id !== node.id)
        .map(task => {
          const isChecked = node.predecessors.includes(task.id) ? "checked" : "";
          return `<label><input type="checkbox" ${isChecked}
            onchange="setPredecessor(${node.id}, ${task.id}, this.checked)">
            ${escapeHtml(task.name)}</label>`;
        })
        .join("") || '<span class="inline-preds-empty">No other tasks</span>';

      if (isEditing) {
        // Build predecessor checkbox list for editing (exclude self)
        const predCheckboxes = tasks
          .filter(t => t.id !== node.id)
          .map(t => {
            const isChecked = node.predecessors.includes(t.id) ? "checked" : "";
            return `
              <label>
                <input type="checkbox" name="edit-preds-${node.id}" value="${t.id}" ${isChecked}>
                ${t.name}
              </label>
            `;
          })
          .join("") || '<span style="color: #999; font-style: italic; font-size: 11px;">No other tasks</span>';

        tr.innerHTML = `
          <td style="text-align: center;"><span style="color: #ccc; cursor: not-allowed;">☰</span></td>
          <td><input type="text" id="edit-name-${node.id}" class="edit-input" value="${node.name}"></td>
          <td><input type="number" id="edit-dur-${node.id}" class="edit-input" min="1" value="${node.plannedDuration}"></td>
          <td><input type="number" min="0" value="${node.actualDuration !== null ? node.actualDuration : ""}" disabled placeholder="—"></td>
          <td>
            <div class="edit-preds-container">
              ${predCheckboxes}
            </div>
          </td>
          <td>—</td>
          <td>—</td>
          <td>—</td>
          <td>—</td>
          <td>—</td>
          <td>
            <div class="action-btn-group">
              <button class="action-btn save-btn" onclick="saveEdit(${node.id})">Save</button>
              <button class="action-btn cancel-btn" onclick="cancelEdit()">Cancel</button>
            </div>
          </td>
        `;
      } else {
        const esVal = cpm.hasCycle ? "—" : node.es;
        const efVal = cpm.hasCycle ? "—" : node.ef;
        const lsVal = cpm.hasCycle ? "—" : node.ls;
        const lfVal = cpm.hasCycle ? "—" : node.lf;
        const floatVal = cpm.hasCycle ? "—" : node.float;

        tr.innerHTML = `
          <td style="text-align: center; vertical-align: middle; white-space: nowrap;">
            <span class="drag-handle" title="Drag to reorder" style="cursor: grab;">☰</span>
            <button class="order-btn" onclick="moveTask(${index}, -1)" ${index === 0 ? "disabled" : ""} title="Move Up">▲</button>
            <button class="order-btn" onclick="moveTask(${index}, 1)" ${index === tasks.length - 1 ? "disabled" : ""} title="Move Down">▼</button>
          </td>
          <td>${node.name}</td>
          <td><input type="number" min="1" step="1" value="${node.plannedDuration}"
              onchange="setPlannedDuration(${node.id}, this.value)" aria-label="Planned duration for ${escapeHtml(node.name)}"></td>
          <td><input type="number" min="0" value="${node.actualDuration !== null ? node.actualDuration : ""}" 
              onchange="setActual(${node.id}, this.value)" placeholder="—"></td>
          <td><div class="inline-preds-container">${inlinePredecessorCheckboxes}</div></td>
          <td>${esVal}</td>
          <td>${efVal}</td>
          <td>${lsVal}</td>
          <td>${lfVal}</td>
          <td>${floatVal}</td>
          <td>
            <div class="action-btn-group">
              <button class="action-btn edit-btn" onclick="startEdit(${node.id})">✏️ Edit</button>
              <button class="action-btn delete-btn" onclick="deleteTask(${node.id})">✕ Delete</button>
            </div>
          </td>
        `;

        // Attach drag handle triggers
        const handle = tr.querySelector(".drag-handle");
        if (handle) {
          handle.addEventListener("mousedown", () => {
            tr.draggable = true;
          });
          handle.addEventListener("mouseup", () => {
            tr.draggable = false;
          });
        }
      }
      scheduleBody.appendChild(tr);
    });
  }

  // Status bar
  statusTasks.textContent = `Tasks: ${tasks.length}`;
  statusDuration.textContent = `Planned Duration: ${cpm.projectDuration}`;

  const actualDur = computeActualDuration();
  statusCritical.textContent = actualDur !== null
    ? `Actual Duration: ${actualDur}`
    : `Actual Duration: —`;

  // Enable/disable analysis button
  const allHaveActuals = tasks.length > 0 && tasks.every(t => t.actualDuration !== null);
  analysisBtn.disabled = !allHaveActuals || cpm.hasCycle;
  if (!allHaveActuals) {
    analysisStatus.textContent = tasks.length === 0
      ? ""
      : "Enter actual durations for all tasks to enable analysis.";
  } else {
    analysisStatus.textContent = "";
  }

  renderVariationSettings(cpm.hasCycle);

  // Render Gantt chart
  renderGantt(cpm);
  persistSchedulerState();
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value);
  return element.innerHTML;
}

function renderVariationSettings(hasCycle) {
  if (!tasks.length) {
    variationSettings.innerHTML = '<div class="empty-msg">Add tasks to configure variations.</div>';
    variationExportBtn.disabled = true;
    variationOpenBtn.disabled = false;
    variationStatus.textContent = "";
    return;
  }

  tasks.forEach(task => {
    if (!variationOffsets[task.id]) variationOffsets[task.id] = { early: Math.min(1, task.plannedDuration), late: 1 };
    variationOffsets[task.id].early = Math.min(variationOffsets[task.id].early, task.plannedDuration);
  });
  const rows = tasks.map(task => {
    const offsets = variationOffsets[task.id];
    return `<tr><td>${escapeHtml(task.name)}</td><td>${task.plannedDuration}</td>
      <td><input class="variation-offset" data-task-id="${task.id}" data-kind="early" type="number" min="0" max="${task.plannedDuration}" step="1" value="${offsets.early}"></td>
      <td><input class="variation-offset" data-task-id="${task.id}" data-kind="late" type="number" min="0" step="1" value="${offsets.late}"></td></tr>`;
  }).join("");
  variationSettings.innerHTML = `<table class="analysis-table"><thead><tr><th>Task</th><th>Planned</th><th>Early by</th><th>Late by</th></tr></thead><tbody>${rows}</tbody></table>`;

  const tooMany = tasks.length > MAX_VARIATION_TASKS;
  variationExportBtn.disabled = hasCycle || tooMany;
  variationOpenBtn.disabled = false;
  variationStatus.textContent = hasCycle
    ? "Resolve the circular dependency first."
    : tooMany
      ? `All-variation analysis supports up to ${MAX_VARIATION_TASKS} tasks.`
      : `${countDistinctVariations(tasks.map(task => ({
          earlyBy: variationOffsets[task.id].early,
          lateBy: variationOffsets[task.id].late
        })))} variations will be generated.`;
}

variationSettings.addEventListener("change", event => {
  const input = event.target.closest(".variation-offset");
  if (!input) return;
  const taskId = Number(input.dataset.taskId);
  const task = tasks.find(item => item.id === taskId);
  if (!task) return;
  let value = Number(input.value);
  if (!Number.isFinite(value) || value < 0) value = 0;
  if (input.dataset.kind === "early") value = Math.min(value, task.plannedDuration);
  variationOffsets[taskId][input.dataset.kind] = value;
  input.value = value;
  persistSchedulerState();
  persistVariationAnalysisInput();
  renderVariationSettings(computeCPM().hasCycle);
});

function buildVariationInput(includeVariations) {
  const sourceTasks = tasks.map(task => ({
    id: task.id,
    name: task.name,
    plannedDuration: task.plannedDuration,
    predecessors: task.predecessors.slice()
  }));
  const settings = sourceTasks.map(task => ({
    taskId: task.id,
    earlyBy: variationOffsets[task.id].early,
    lateBy: variationOffsets[task.id].late
  }));
  const output = {
    format: "cpm-shapley-variations",
    version: 1,
    generatedAt: new Date().toISOString(),
    project: { plannedDuration: computeCPM().projectDuration, tasks: sourceTasks },
    settings
  };
  if (includeVariations) output.variations = generateVariations(sourceTasks, settings);
  return output;
}

function persistVariationAnalysisInput() {
  const cpm = computeCPM();
  try {
    if (tasks.length && !cpm.hasCycle && tasks.length <= MAX_VARIATION_TASKS) {
      localStorage.setItem(VARIATION_ANALYSIS_STORAGE_KEY, JSON.stringify(buildVariationInput(false)));
      return true;
    }
    localStorage.removeItem(VARIATION_ANALYSIS_STORAGE_KEY);
  } catch (error) {
    console.warn("Could not save the variation analysis input.", error);
  }
  return false;
}

function generateVariations(sourceTasks, settings) {
  const settingsById = Object.fromEntries(settings.map(item => [item.taskId, item]));
  const total = countDistinctVariations(settings);
  const variations = new Array(total);
  for (let index = 0; index < total; index++) {
    let encoded = index;
    const outcomes = sourceTasks.map(task => {
      const setting = settingsById[task.id];
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
    variations[index] = { id: index + 1, outcomes };
  }
  return variations;
}

variationExportBtn.addEventListener("click", () => {
  const output = buildVariationInput(true);
  const blob = new Blob([JSON.stringify(output, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "cpm_shapley_variations.json";
  link.click();
  URL.revokeObjectURL(url);
});

variationOpenBtn.addEventListener("click", () => {
  persistSchedulerState();
  persistVariationAnalysisInput();
  window.location.href = "variations.html";
});

// ── Edit Task Functions ────────────────────────────────────────────
function startEdit(id) {
  editingTaskId = id;
  render();
}

// ── Cancel Edit Task Function ──────────────────────────────────────
function cancelEdit() {
  editingTaskId = null;
  render();
}

// ── Save Edit Task Function ────────────────────────────────────────
function saveEdit(id) {
  const nameInput = document.getElementById(`edit-name-${id}`);
  const durationInput = document.getElementById(`edit-dur-${id}`);
  const predContainer = document.querySelector(`.edit-preds-container`);

  if (!nameInput || !durationInput) return;

  const name = nameInput.value.trim();
  const dur = parseInt(durationInput.value, 10);

  if (!name) { alert("Enter a task name."); return; }
  if (isNaN(dur) || dur < 1) { alert("Enter a valid duration (≥ 1)."); return; }

  const task = tasks.find(t => t.id === id);
  if (!task) return;

  // Validate unique name among other tasks
  if (tasks.some(t => t.id !== id && t.name === name)) {
    alert("Task name must be unique.");
    return;
  }

  // Gather selected predecessors from checkboxes
  const preds = [];
  if (predContainer) {
    const checkedBoxes = predContainer.querySelectorAll(`input[type="checkbox"]:checked`);
    checkedBoxes.forEach(cb => {
      preds.push(parseInt(cb.value, 10));
    });
  }

  // Temporarily store old settings to check for cycles
  const oldPredecessors = task.predecessors;
  const oldName = task.name;
  const oldPlannedDuration = task.plannedDuration;

  task.name = name;
  task.plannedDuration = dur;
  task.predecessors = preds;

  // Check for cycle
  const hasCycle = topologicalSort(tasks) === null;
  if (hasCycle) {
    alert("Cannot save: this change would introduce a circular dependency.");
    // Revert
    task.name = oldName;
    task.plannedDuration = oldPlannedDuration;
    task.predecessors = oldPredecessors;
    return;
  }

  editingTaskId = null;
  render();
}

// ── Move Task (Manual Reordering) ──────────────────────────────────
function moveTask(index, direction) {
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= tasks.length) return;

  const temp = tasks[index];
  tasks[index] = tasks[newIndex];
  tasks[newIndex] = temp;
  render();
}

// ── Drag & Drop Functions ──────────────────────────────────────────
let dragSrcIndex = null;

function handleDragStart(e, index) {
  dragSrcIndex = index;
  e.dataTransfer.effectAllowed = "move";
  e.target.classList.add("dragging");
}

function handleDragOver(e) {
  if (e.preventDefault) {
    e.preventDefault();
  }
  e.dataTransfer.dropEffect = "move";
  return false;
}

function handleDrop(e, targetIndex) {
  if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;

  // Reorder in tasks array
  const draggedTask = tasks.splice(dragSrcIndex, 1)[0];
  tasks.splice(targetIndex, 0, draggedTask);

  render();
}

function handleDragEnd(e) {
  const draggingRow = document.querySelector(".dragging");
  if (draggingRow) {
    draggingRow.classList.remove("dragging");
  }
  dragSrcIndex = null;
}


// ── Export JSON ────────────────────────────────────────────────────
exportBtn.addEventListener("click", () => {
  const cpm = computeCPM();
  const actualDur = computeActualDuration();

  const output = {
    projectSummary: {
      totalTasks: tasks.length,
      plannedDuration: cpm.projectDuration,
      actualDuration: actualDur
    },
    variationSettings: cpm.nodes.map(node => {
      const offsets = variationOffsets[node.id] || {
        early: Math.min(1, node.plannedDuration),
        late: 1
      };
      return {
        taskId: node.id,
        taskName: node.name,
        earlyBy: Math.min(offsets.early, node.plannedDuration),
        lateBy: offsets.late
      };
    }),
    tasks: cpm.nodes.map(node => ({
      id: node.id,
      name: node.name,
      plannedDuration: node.plannedDuration,
      actualDuration: node.actualDuration,
      predecessors: node.predecessors.map(pid => {
        const t = tasks.find(x => x.id === pid);
        return { id: pid, name: t ? t.name : "unknown" };
      }),
      earlyStart: node.es,
      earlyFinish: node.ef,
      lateStart: node.ls,
      lateFinish: node.lf,
      totalFloat: node.float,
      isCritical: node.float === 0
    }))
  };

  const blob = new Blob([JSON.stringify(output, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "cpm_schedule.json";
  a.click();
  URL.revokeObjectURL(url);
});

// ── Import JSON ────────────────────────────────────────────────────
importBtn.addEventListener("click", () => {
  importFile.value = ""; // reset so same file can be re-imported
  importFile.click();
});

importFile.addEventListener("change", () => {
  const file = importFile.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    let parsed;
    try {
      parsed = JSON.parse(e.target.result);
    } catch {
      alert("Invalid JSON file.");
      return;
    }

    // Accept both the full export format ({ tasks: [...] })
    // and a bare array of task objects.
    const rawTasks = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.tasks)
        ? parsed.tasks
        : null;
    const importedVariationSettings = !Array.isArray(parsed) && Array.isArray(parsed.variationSettings)
      ? parsed.variationSettings
      : [];

    if (!rawTasks) {
      alert("Unrecognised format: expected a JSON file exported from this app.");
      return;
    }

    // Validate required fields on each task
    for (const t of rawTasks) {
      if (typeof t.name !== "string" || !t.name.trim()) {
        alert("Import failed: every task must have a non-empty \"name\".");
        return;
      }
      if (typeof t.plannedDuration !== "number" || t.plannedDuration < 1) {
        alert(`Import failed: task "${t.name}" has an invalid plannedDuration.`);
        return;
      }
    }

    // Check for duplicate names within the file
    const names = rawTasks.map(t => t.name.trim());
    const uniqueNames = new Set(names);
    if (uniqueNames.size !== names.length) {
      alert("Import failed: duplicate task names detected in the file.");
      return;
    }

    // Build new tasks array.
    // The exported format stores predecessors as [{id, name}];
    // we remap them by name so IDs are stable even if the file was hand-edited.
    tasks = [];
    ganttOrder = [];
    variationOffsets = {};
    nextId = 1;

    // First pass: create tasks without predecessors
    const nameToId = {};
    rawTasks.forEach(t => {
      const newId = nextId++;
      const taskName = t.name.trim();
      nameToId[taskName] = newId;
      tasks.push({
        id: newId,
        name: taskName,
        plannedDuration: t.plannedDuration,
        actualDuration: (typeof t.actualDuration === "number" && t.actualDuration >= 0)
          ? t.actualDuration
          : null,
        predecessors: [] // filled in second pass
      });
      ganttOrder.push(newId);

      const importedSettings = importedVariationSettings.find(setting =>
        setting && (setting.taskName === taskName || String(setting.taskId) === String(t.id))
      );
      const earlyBy = importedSettings && Number.isFinite(importedSettings.earlyBy) && importedSettings.earlyBy >= 0
        ? Math.min(importedSettings.earlyBy, t.plannedDuration)
        : Math.min(1, t.plannedDuration);
      const lateBy = importedSettings && Number.isFinite(importedSettings.lateBy) && importedSettings.lateBy >= 0
        ? importedSettings.lateBy
        : 1;
      variationOffsets[newId] = { early: earlyBy, late: lateBy };
    });

    // Second pass: resolve predecessors
    rawTasks.forEach((raw, idx) => {
      const task = tasks[idx];
      const preds = raw.predecessors;
      if (!Array.isArray(preds)) return;

      preds.forEach(p => {
        // Support {id, name} objects (export format) or bare name strings
        const predName = typeof p === "object" ? p.name : String(p);
        const predId = nameToId[predName];
        if (predId !== undefined && predId !== task.id) {
          task.predecessors.push(predId);
        }
      });
    });

    render();
  };

  reader.readAsText(file);
});

// ── Gantt Drag & Drop Functions ────────────────────────────────────
let ganttDragSrcIndex = null;

function handleGanttDragStart(e, index) {
  ganttDragSrcIndex = index;
  e.dataTransfer.effectAllowed = "move";
  e.target.classList.add("dragging");
}

function handleGanttDrop(e, targetIndex) {
  if (ganttDragSrcIndex === null || ganttDragSrcIndex === targetIndex) return;

  // Reorder in ganttOrder array
  const draggedId = ganttOrder.splice(ganttDragSrcIndex, 1)[0];
  ganttOrder.splice(targetIndex, 0, draggedId);

  render();
}

function handleGanttDragEnd(e) {
  const draggingRow = document.querySelector(".gantt-row.dragging");
  if (draggingRow) {
    draggingRow.classList.remove("dragging");
  }
  ganttDragSrcIndex = null;
}

// ── Gantt Chart Rendering ──────────────────────────────────────────
function renderGantt(cpm) {
  ganttContainer.innerHTML = "";

  if (tasks.length === 0 || cpm.hasCycle) {
    const msg = document.createElement("div");
    msg.className = "empty-msg";
    msg.textContent = cpm.hasCycle ? "Cannot render: circular dependency." : "No tasks to display.";
    msg.style.padding = "8px";
    ganttContainer.appendChild(msg);
    return;
  }

  // Synchronize ganttOrder with tasks
  const taskIds = tasks.map(t => t.id);
  ganttOrder = ganttOrder.filter(id => taskIds.includes(id));
  taskIds.forEach(id => {
    if (!ganttOrder.includes(id)) {
      ganttOrder.push(id);
    }
  });

  // Sort nodes by ganttOrder
  const ganttNodes = ganttOrder.map(id => cpm.nodes.find(n => n.id === id)).filter(Boolean);

  const CELL_W = 28; // px per time unit
  const ROW_H = 22;  // px per row (matches CSS .gantt-row height)
  const HEADER_H = 20; // header row height
  const LABEL_W = 110; // label column width
  const BAR_MID = 7;   // vertical midpoint of planned bar within row (top:2 + height:10/2)
  const BAR_MID_ACTUAL = 15.5; // vertical midpoint of actual bar (top:12 + height:7/2)
  const projectDur = cpm.projectDuration;

  const showPlanned = togglePlanned.checked;
  const showActual = toggleActual.checked;
  const showRelations = toggleRelations.checked;

  // Compute actual timings for overlay bars
  const actualMap = {};
  const allHaveActual = tasks.every(t => t.actualDuration !== null);
  if (allHaveActual) {
    const aMap = {};
    tasks.forEach(t => { aMap[t.id] = { ...t, es: 0, ef: 0 }; });
    cpm.nodes.forEach(node => {
      const a = aMap[node.id];
      if (a.predecessors.length === 0) {
        a.es = 0;
      } else {
        a.es = Math.max(...a.predecessors.map(pid => aMap[pid] ? aMap[pid].ef : 0));
      }
      a.ef = a.es + a.actualDuration;
    });
    tasks.forEach(t => { actualMap[t.id] = aMap[t.id]; });
  }

  // Calculate maxTime based on toggled schedules
  let maxTime = 0;
  if (showPlanned) {
    maxTime = Math.max(maxTime, projectDur);
  }
  if (showActual && allHaveActual) {
    const maxActual = Math.max(...Object.values(actualMap).map(a => a.ef), 0);
    maxTime = Math.max(maxTime, maxActual);
  }
  if (maxTime === 0) {
    maxTime = Math.max(projectDur, 1);
  }

  // Wrapper for rows + SVG overlay
  const wrapper = document.createElement("div");
  wrapper.style.position = "relative";

  // Build header
  const header = document.createElement("div");
  header.className = "gantt-header";

  const labelH = document.createElement("div");
  labelH.className = "gantt-label-header";
  labelH.textContent = "Task";
  header.appendChild(labelH);

  const timeHeaders = document.createElement("div");
  timeHeaders.className = "gantt-time-headers";
  for (let i = 0; i < maxTime; i++) {
    const cell = document.createElement("div");
    cell.className = "gantt-time-cell";
    cell.textContent = i;
    timeHeaders.appendChild(cell);
  }
  header.appendChild(timeHeaders);
  wrapper.appendChild(header);

  // Build a map of node id → row index for arrow positioning (using Gantt row index)
  const rowIndex = {};
  ganttNodes.forEach((node, idx) => { rowIndex[node.id] = idx; });

  // Build rows
  ganttNodes.forEach((node, index) => {
    const row = document.createElement("div");
    row.className = "gantt-row";
    row.draggable = true;

    row.addEventListener("dragstart", (e) => {
      handleGanttDragStart(e, index);
    });
    row.addEventListener("dragover", handleDragOver);
    row.addEventListener("drop", (e) => handleGanttDrop(e, index));
    row.addEventListener("dragend", handleGanttDragEnd);

    const label = document.createElement("div");
    label.className = "gantt-row-label";
    label.textContent = node.name;
    label.title = node.name;
    row.appendChild(label);

    const bars = document.createElement("div");
    bars.className = "gantt-row-bars";

    // Grid cells (background)
    for (let i = 0; i < maxTime; i++) {
      const gc = document.createElement("div");
      gc.className = "gantt-grid-cell";
      bars.appendChild(gc);
    }

    // Planned bar
    if (showPlanned) {
      const pBar = document.createElement("div");
      pBar.className = "gantt-bar planned" + (node.float === 0 ? " critical" : "");
      pBar.style.left = (node.es * CELL_W) + "px";
      pBar.style.width = (node.plannedDuration * CELL_W - 2) + "px";
      pBar.title = `${node.name} (planned): ${node.es}–${node.ef}`;
      bars.appendChild(pBar);
    }

    // Actual bar (if available and toggled)
    if (showActual && actualMap[node.id]) {
      const a = actualMap[node.id];
      const aBar = document.createElement("div");
      aBar.className = "gantt-bar actual";
      aBar.style.left = (a.es * CELL_W) + "px";
      aBar.style.width = (a.actualDuration * CELL_W - 2) + "px";
      aBar.title = `${node.name} (actual): ${a.es}–${a.ef}`;
      bars.appendChild(aBar);
    }

    row.appendChild(bars);
    wrapper.appendChild(row);
  });

  // SVG overlay for dependency arrows
  if (showRelations && (showPlanned || (showActual && allHaveActual))) {
    const totalW = LABEL_W + maxTime * CELL_W;
    const totalH = HEADER_H + ganttNodes.length * ROW_H;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", totalW);
    svg.setAttribute("height", totalH);
    svg.style.position = "absolute";
    svg.style.top = "0";
    svg.style.left = "0";
    svg.style.pointerEvents = "none";

    // Arrowhead markers
    const defs = document.createElementNS(svgNS, "defs");

    // Planned marker
    const markerPlanned = document.createElementNS(svgNS, "marker");
    markerPlanned.setAttribute("id", "gantt-arrow-planned");
    markerPlanned.setAttribute("viewBox", "0 0 10 10");
    markerPlanned.setAttribute("refX", "10");
    markerPlanned.setAttribute("refY", "5");
    markerPlanned.setAttribute("markerWidth", "6");
    markerPlanned.setAttribute("markerHeight", "6");
    markerPlanned.setAttribute("orient", "auto-start-reverse");
    const arrowPathPlanned = document.createElementNS(svgNS, "path");
    arrowPathPlanned.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrowPathPlanned.setAttribute("fill", "#666");
    markerPlanned.appendChild(arrowPathPlanned);
    defs.appendChild(markerPlanned);

    // Actual marker
    const markerActual = document.createElementNS(svgNS, "marker");
    markerActual.setAttribute("id", "gantt-arrow-actual");
    markerActual.setAttribute("viewBox", "0 0 10 10");
    markerActual.setAttribute("refX", "10");
    markerActual.setAttribute("refY", "5");
    markerActual.setAttribute("markerWidth", "6");
    markerActual.setAttribute("markerHeight", "6");
    markerActual.setAttribute("orient", "auto-start-reverse");
    const arrowPathActual = document.createElementNS(svgNS, "path");
    arrowPathActual.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrowPathActual.setAttribute("fill", "#3a6b99");
    markerActual.appendChild(arrowPathActual);
    defs.appendChild(markerActual);

    svg.appendChild(defs);

    // Helper to draw routed arrows
    const drawArrow = (x1, y1, x2, y2, predRow, succRow, color, markerId) => {
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", "1");
      path.setAttribute("marker-end", `url(#${markerId})`);

      if (x1 === x2 && predRow !== succRow) {
        const jogX = x1 + 4;
        path.setAttribute("d", `M ${x1} ${y1} L ${jogX} ${y1} L ${jogX} ${y2} L ${x2} ${y2}`);
      } else {
        const midX = (x1 + x2) / 2;
        path.setAttribute("d", `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`);
      }
      svg.appendChild(path);
    };

    // Draw planned arrows
    if (showPlanned) {
      ganttNodes.forEach(node => {
        node.predecessors.forEach(pid => {
          if (rowIndex[pid] === undefined) return;
          const predNode = ganttNodes.find(n => n.id === pid);
          if (!predNode) return;

          const predRow = rowIndex[pid];
          const succRow = rowIndex[node.id];

          const x1 = LABEL_W + predNode.ef * CELL_W;
          const x2 = LABEL_W + node.es * CELL_W;
          const y1 = HEADER_H + predRow * ROW_H + BAR_MID;
          const y2 = HEADER_H + succRow * ROW_H + BAR_MID;

          drawArrow(x1, y1, x2, y2, predRow, succRow, "#666", "gantt-arrow-planned");
        });
      });
    }

    // Draw actual arrows
    if (showActual && allHaveActual) {
      ganttNodes.forEach(node => {
        node.predecessors.forEach(pid => {
          if (rowIndex[pid] === undefined) return;
          const predNode = actualMap[pid];
          const succNode = actualMap[node.id];
          if (!predNode || !succNode) return;

          const predRow = rowIndex[pid];
          const succRow = rowIndex[node.id];

          const x1 = LABEL_W + predNode.ef * CELL_W;
          const x2 = LABEL_W + succNode.es * CELL_W;
          const y1 = HEADER_H + predRow * ROW_H + BAR_MID_ACTUAL;
          const y2 = HEADER_H + succRow * ROW_H + BAR_MID_ACTUAL;

          drawArrow(x1, y1, x2, y2, predRow, succRow, "#3a6b99", "gantt-arrow-actual");
        });
      });
    }

    wrapper.appendChild(svg);
  }

  ganttContainer.appendChild(wrapper);
}

// ── Analysis Rendering ─────────────────────────────────────────────
function renderAnalysis(plannedProjectDuration) {
  const start_time = Date.now();
  analysisResults.innerHTML = "";

  const methods = computeShapleyMethods(tasks, plannedProjectDuration);
  if (!methods) {
    analysisResults.innerHTML = '<div class="empty-msg">Analysis not available.</div>';
    return;
  }

  printShapleyDebugLog(methods.projectEnd.debugLog);
  printShapleyDebugLog(methods.deviation.debugLog);

  function appendMethod(result, title, description) {
  const { results, totalDelay, shapleySum } = result;
  const heading = document.createElement("h3");
  heading.className = "analysis-method-title";
  heading.textContent = title;
  analysisResults.appendChild(heading);
  const explanation = document.createElement("p");
  explanation.className = "analysis-description";
  explanation.textContent = description;
  analysisResults.appendChild(explanation);

  // Summary header
  const summary = document.createElement("div");
  summary.className = "analysis-summary";

  const delayLabel = totalDelay >= 0 ? "Total Delay" : "Total Acceleration";
  const delayClass = totalDelay >= 0 ? "delay" : "accel";
  summary.innerHTML = result.method === "deviation"
    ? `<span>Null Coalition: <strong>0</strong></span><span>Grand Coalition (most positive deviation): <strong>${totalDelay >= 0 ? "+" : ""}${round(totalDelay)}</strong></span>`
    : `<span>Planned Project End: <strong>${result.plannedDuration}</strong></span><span>Actual Project End: <strong>${result.actualDuration}</strong></span><span class="${delayClass}">${delayLabel}: <strong>${totalDelay >= 0 ? "+" : ""}${round(totalDelay)}</strong></span>`;
  analysisResults.appendChild(summary);

  // Results table
  const table = document.createElement("table");
  table.className = "analysis-table";

  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>Task</th>
      <th>Planned</th>
      <th>Actual</th>
      <th>Deviation</th>
      <th>Shapley Value</th>
      <th>Responsibility %</th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  results.forEach(r => {
    const tr = document.createElement("tr");

    // Row color coding
    if (r.deviation > 0) tr.className = "analysis-delay";
    else if (r.deviation < 0) tr.className = "analysis-accel";

    const svSign = r.shapleyValue >= 0 ? "+" : "";
    const devSign = r.deviation >= 0 ? "+" : "";
    const pctDisplay = totalDelay !== 0 ? round(r.responsibilityPct) + "%" : "—";

    tr.innerHTML = `
      <td>${r.name}</td>
      <td>${r.planned}</td>
      <td>${r.actual}</td>
      <td>${devSign}${r.deviation}</td>
      <td class="sv-cell ${r.shapleyValue > 0 ? 'sv-delay' : r.shapleyValue < 0 ? 'sv-accel' : ''}">
        ${svSign}${round(r.shapleyValue)}
      </td>
      <td>${pctDisplay}</td>
    `;
    tbody.appendChild(tr);
  });

  // Totals row
  const totalRow = document.createElement("tr");
  totalRow.className = "analysis-total";
  const sumSign = shapleySum >= 0 ? "+" : "";
  totalRow.innerHTML = `
    <td colspan="4"><strong>Total (Shapley Sum)</strong></td>
    <td><strong>${sumSign}${round(shapleySum)}</strong></td>
    <td></td>
  `;
  tbody.appendChild(totalRow);

  table.appendChild(tbody);
  analysisResults.appendChild(table);
  }

  appendMethod(
    methods.projectEnd,
    "Method 1 — Project End Date",
    "The null coalition uses all planned durations. Each coalition recomputes the project end with actual durations only for its included tasks."
  );
  appendMethod(
    methods.deviation,
    "Method 2 — Deviation from Planned",
    "Each task is actual minus planned; a non-empty coalition is valued at its most positive task deviation."
  );
  console.log("Analysis completed in", Date.now() - start_time, "ms");
}

// ── Round helper ───────────────────────────────────────────────────
function round(value) {
  return Math.round(value * 1000) / 1000;
}

// ── Initial render ─────────────────────────────────────────────────
window.addEventListener("storage", event => {
  if (event.key !== VARIATION_ANALYSIS_STORAGE_KEY || !event.newValue) return;
  try {
    if (syncVariationOffsetsFromAnalysis(JSON.parse(event.newValue))) render();
  } catch {
    // Ignore invalid state written by another tab.
  }
});

window.addEventListener("pageshow", event => {
  if (event.persisted && syncVariationOffsetsFromAnalysis()) render();
});

restoreSchedulerState();
render();
