"use strict";

// ═════════════════════════════════════════════════════════════════
// Shapley Value Calculator for Schedule Analysis
// ═════════════════════════════════════════════════════════════════
// Players  = tasks.
// Baseline = the all-planned schedule, v(∅).
// v(S)     = project completion time when every task in coalition S
//            runs at its ACTUAL duration and every task outside S
//            runs at its PLANNED duration (dependencies/order are
//            always respected via a single forward CPM pass).
// φ_i      = task i's Shapley value = its fairly-weighted average
//            marginal contribution to v(S) across every coalition,
//            i.e. how much of the (actual − planned) deviation is
//            attributable to that task.
//
// This enumerates the full 2^n powerset of coalitions (exact
// Shapley calculation), which is why task count is capped below.
const SHAPLEY_MAX_EXACT_TASKS = 20;   // 2^20 ≈ 1M coalitions — practical ceiling
const SHAPLEY_DEBUG_DETAIL_LIMIT = 10; // keep per-coalition console trace readable
const VARIATION_ANALYSIS_STORAGE_KEY = "cpmVariationAnalysisInput";

function getDistinctVariationStates(setting) {
  const states = [];
  if (setting.earlyBy > 0) states.push({ status: "early", deviation: -setting.earlyBy });
  states.push({ status: "onTime", deviation: 0 });
  if (setting.lateBy > 0) states.push({ status: "delayed", deviation: setting.lateBy });
  return states;
}

function countDistinctVariations(settings) {
  return settings.reduce((total, setting) => total * getDistinctVariationStates(setting).length, 1);
}

function variationTaskListsMatch(firstTasks, secondTasks) {
  if (!Array.isArray(firstTasks) || !Array.isArray(secondTasks) || firstTasks.length !== secondTasks.length) {
    return false;
  }
  const secondById = new Map(secondTasks.map(task => [String(task.id), task]));
  return firstTasks.every(task => {
    const other = secondById.get(String(task.id));
    if (!other || task.name !== other.name || task.plannedDuration !== other.plannedDuration) return false;
    const predecessors = Array.isArray(task.predecessors) ? task.predecessors.map(String).sort() : [];
    const otherPredecessors = Array.isArray(other.predecessors) ? other.predecessors.map(String).sort() : [];
    return predecessors.length === otherPredecessors.length &&
      predecessors.every((id, index) => id === otherPredecessors[index]);
  });
}

function popcount(x) {
  let c = 0;
  while (x) { c += x & 1; x >>= 1; }
  return c;
}

function computeShapleyValuesDebug(taskList, plannedProjectDuration) {
  const n = taskList.length;
  if (n === 0) return null;
  if (taskList.some(t => t.actualDuration === null)) return null;

  if (n > SHAPLEY_MAX_EXACT_TASKS) {
    console.warn(
      `[Shapley] Skipped: ${n} tasks would require evaluating 2^${n} coalitions, ` +
      `which is impractical to compute exactly. Exact analysis currently supports ` +
      `up to ${SHAPLEY_MAX_EXACT_TASKS} tasks.`
    );
    return null;
  }

  const order = topologicalSort(taskList);
  if (!order) return null; // circular dependency — caller already guards this too

  // Map each task to a bit position so a coalition can be a bitmask.
  const idToIndex = {};
  taskList.forEach((t, i) => { idToIndex[t.id] = i; });
  const predIndices = taskList.map(t =>
    t.predecessors.map(pid => idToIndex[pid]).filter(idx => idx !== undefined)
  );
  const orderIdx = order.map(id => idToIndex[id]);

  const numCoalitions = 1 << n; // 2^n, including the empty coalition

  // ── Characteristic function v(S) ──────────────────────────────────
  // One forward CPM pass: task uses actualDuration if its bit is set
  // in `mask`, otherwise plannedDuration. Returns project duration
  // (the longest path / max early-finish, same definition computeCPM
  // and computeActualDuration use).
  const efScratch = new Array(n);
  function valueOf(mask) {
    for (let k = 0; k < orderIdx.length; k++) {
      const idx = orderIdx[k];
      const preds = predIndices[idx];
      let es = 0;
      for (let p = 0; p < preds.length; p++) {
        if (efScratch[preds[p]] > es) es = efScratch[preds[p]];
      }
      const usesActual = (mask & (1 << idx)) !== 0;
      const dur = usesActual ? taskList[idx].actualDuration : taskList[idx].plannedDuration;
      efScratch[idx] = es + dur;
    }
    let maxEf = 0;
    for (let i = 0; i < n; i++) if (efScratch[i] > maxEf) maxEf = efScratch[i];
    return maxEf;
  }

  // Precompute v(S) for every one of the 2^n coalitions once.
  const vValues = new Array(numCoalitions);
  vValues[0] = valueOf(0);
  const baseline = vValues[0]; // v(∅): everyone planned

  // Pure project-end method: no task-specific override is applied.
  for (let mask = 1; mask < numCoalitions; mask++) vValues[mask] = valueOf(mask);

  const fullValue = vValues[numCoalitions - 1];  // v(N): everyone actual

  if (round(baseline) !== round(plannedProjectDuration)) {
    console.warn(
      `[Shapley] Baseline mismatch: coalition-based v(∅)=${baseline} vs ` +
      `supplied plannedProjectDuration=${plannedProjectDuration}. Using v(∅).`
    );
  }

  // Factorials for the standard Shapley weighting: |S|!(n-|S|-1)!/n!
  const fact = [1];
  for (let i = 1; i <= n; i++) fact[i] = fact[i - 1] * i;
  const nFact = fact[n];

  const shapley = new Array(n).fill(0);
  const keepDetail = n <= SHAPLEY_DEBUG_DETAIL_LIMIT;

  // Full coalition list, for the "set of all possible coalitions" trace.
  let coalitionLog = null;
  if (keepDetail) {
    coalitionLog = [];
    for (let mask = 0; mask < numCoalitions; mask++) {
      const members = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) members.push(taskList[i].name);
      coalitionLog.push({
        mask,
        members,
        value: vValues[mask],
        deltaFromBaseline: vValues[mask] - baseline
      });
    }
  }

  const perTaskLog = taskList.map(t => ({
    taskId: t.id,
    taskName: t.name,
    marginalContributions: keepDetail ? [] : null
  }));

  // For every coalition T that contains player i, S = T \ {i} is the
  // coalition "before" i joins. The marginal contribution v(T) - v(S)
  // is weighted by |S|!(n-|S|-1)!/n! and accumulated into φ_i.
  for (let mask = 1; mask < numCoalitions; mask++) {
    for (let i = 0; i < n; i++) {
      const bit = 1 << i;
      if (!(mask & bit)) continue;

      const sMask = mask & ~bit;
      const sSize = popcount(sMask);
      const weight = (fact[sSize] * fact[n - sSize - 1]) / nFact;
      const marginal = vValues[mask] - vValues[sMask];
      const weightedContribution = weight * marginal;
      shapley[i] += weightedContribution;

      if (keepDetail) {
        const sMembers = [];
        for (let k = 0; k < n; k++) if (sMask & (1 << k)) sMembers.push(taskList[k].name);
        perTaskLog[i].marginalContributions.push({
          coalitionBefore: sMembers,
          valueWithout: vValues[sMask],
          valueWith: vValues[mask],
          marginal,
          weight,
          weightedContribution
        });
      }
    }
  }

  perTaskLog.forEach((p, i) => { p.shapleyValue = shapley[i]; });

  const actualDuration = fullValue;
  const totalDelay = actualDuration - baseline;
  const shapleySum = shapley.reduce((a, b) => a + b, 0);

  const results = taskList.map((t, i) => {
    const deviation = t.actualDuration - t.plannedDuration;
    const shapleyValue = shapley[i];
    const responsibilityPct = totalDelay !== 0 ? (shapleyValue / totalDelay) * 100 : 0;
    return {
      id: t.id,
      name: t.name,
      planned: t.plannedDuration,
      actual: t.actualDuration,
      deviation,
      shapleyValue,
      responsibilityPct
    };
  });

  return {
    results,
    totalDelay,
    shapleySum,
    plannedDuration: baseline,
    actualDuration,
    debugLog: {
      n,
      numCoalitions,
      baseline,
      fullValue,
      detailKept: keepDetail,
      coalitions: coalitionLog, // null when n > SHAPLEY_DEBUG_DETAIL_LIMIT
      perTask: perTaskLog
    }
  };
}

// Deviation-only characteristic function:
// v(∅) = 0; v(S) is the most positive (maximum) actual-minus-planned
// deviation among the tasks in S. Dependencies do not affect this method.
function computeDeviationShapleyValues(taskList) {
  const n = taskList.length;
  if (n === 0 || taskList.some(t => t.actualDuration === null)) return null;
  if (n > SHAPLEY_MAX_EXACT_TASKS) return null;

  const numCoalitions = 2 ** n;
  const deviations = taskList.map(t => t.actualDuration - t.plannedDuration);
  const vValues = new Array(numCoalitions).fill(0);
  for (let mask = 1; mask < numCoalitions; mask++) {
    let mostPositive = -Infinity;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) mostPositive = Math.max(mostPositive, deviations[i]);
    }
    vValues[mask] = mostPositive;
  }

  const fact = [1];
  for (let i = 1; i <= n; i++) fact[i] = fact[i - 1] * i;
  const shapley = new Array(n).fill(0);
  const keepDetail = n <= SHAPLEY_DEBUG_DETAIL_LIMIT;
  const perTaskLog = taskList.map(t => ({
    taskId: t.id,
    taskName: t.name,
    marginalContributions: keepDetail ? [] : null
  }));

  for (let mask = 1; mask < numCoalitions; mask++) {
    for (let i = 0; i < n; i++) {
      const bit = 1 << i;
      if (!(mask & bit)) continue;
      const sMask = mask & ~bit;
      const sSize = popcount(sMask);
      const weight = (fact[sSize] * fact[n - sSize - 1]) / fact[n];
      const marginal = vValues[mask] - vValues[sMask];
      const weightedContribution = weight * marginal;
      shapley[i] += weightedContribution;
      if (keepDetail) {
        const members = [];
        for (let k = 0; k < n; k++) if (sMask & (1 << k)) members.push(taskList[k].name);
        perTaskLog[i].marginalContributions.push({
          coalitionBefore: members,
          valueWithout: vValues[sMask],
          valueWith: vValues[mask],
          marginal,
          weight,
          weightedContribution
        });
      }
    }
  }

  const fullValue = vValues[numCoalitions - 1];
  const shapleySum = shapley.reduce((sum, value) => sum + value, 0);
  perTaskLog.forEach((task, i) => { task.shapleyValue = shapley[i]; });
  const coalitionLog = keepDetail ? vValues.map((value, mask) => {
    const members = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) members.push(taskList[i].name);
    return { mask, members, value, deltaFromBaseline: value };
  }) : null;

  return {
    method: "deviation",
    results: taskList.map((t, i) => ({
      id: t.id,
      name: t.name,
      planned: t.plannedDuration,
      actual: t.actualDuration,
      deviation: deviations[i],
      shapleyValue: shapley[i],
      responsibilityPct: fullValue !== 0 ? (shapley[i] / fullValue) * 100 : 0
    })),
    baseline: 0,
    fullValue,
    totalValue: fullValue,
    totalDelay: fullValue,
    shapleySum,
    debugLog: {
      method: "deviation",
      n,
      numCoalitions,
      baseline: 0,
      fullValue,
      detailKept: keepDetail,
      coalitions: coalitionLog,
      perTask: perTaskLog
    }
  };
}

function computeShapleyMethods(taskList, plannedProjectDuration) {
  const projectEnd = computeShapleyValuesDebug(taskList, plannedProjectDuration);
  const deviation = computeDeviationShapleyValues(taskList);
  if (!projectEnd || !deviation) return null;
  projectEnd.method = "projectEnd";
  projectEnd.baseline = projectEnd.plannedDuration;
  projectEnd.fullValue = projectEnd.actualDuration;
  projectEnd.totalValue = projectEnd.totalDelay;
  projectEnd.debugLog.method = "projectEnd";
  return { projectEnd, deviation };
}

// ── Shapley Debug Log Printer 
function printShapleyDebugLog(debugLog) {
  if (!debugLog) return;
  const { n, numCoalitions, baseline, fullValue, detailKept, coalitions, perTask } = debugLog;

  const methodLabel = debugLog.method === "deviation" ? "Deviation" : "Project End";
  console.group(`${methodLabel} Shapley Value Analysis — ${n} tasks, ${numCoalitions} coalitions`);
  console.log(`Null coalition v(∅):                 ${baseline}`);
  console.log(`Grand coalition v(N):                ${fullValue}`);
  console.log(`Total value v(N) − v(∅):             ${fullValue - baseline}`);

  if (detailKept && coalitions) {
    console.group("All coalitions S and their value v(S)");
    console.table(coalitions.map(c => ({
      coalition: c.members.length ? c.members.join(", ") : "∅",
      "v(S)": c.value,
      "Δ from baseline": round(c.deltaFromBaseline)
    })));
    console.groupEnd();
  } else {
    console.log(
      `(Per-coalition trace skipped: ${numCoalitions} coalitions is too many to log in detail. ` +
      `Shapley values below are still exact.)`
    );
  }

  perTask.forEach(p => {
    console.group(`Task "${p.taskName}" — Shapley value: ${round(p.shapleyValue)}`);
    if (detailKept && p.marginalContributions) {
      console.table(p.marginalContributions.map(m => ({
        "coalition before (S)": m.coalitionBefore.length ? m.coalitionBefore.join(", ") : "∅",
        "v(S)": m.valueWithout,
        "v(S ∪ {i})": m.valueWith,
        "marginal": round(m.marginal),
        "weight": round(m.weight),
        "weighted contribution": round(m.weightedContribution)
      })));
    } else {
      console.log(`Computed from ${1 << (n - 1)} coalitions (detail not logged for performance).`);
    }
    console.groupEnd();
  });

  console.groupEnd();
}
