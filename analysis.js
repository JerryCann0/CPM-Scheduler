"use strict";

// ═════════════════════════════════════════════════════════════════
// Shapley Value Calculator for Schedule Analysis
// ═════════════════════════════════════════════════════════════════
// Players  = tasks.
// Performance_i = actualDuration_i - plannedDuration_i.
// Baseline      = 0 for the empty coalition, v(∅).
// v(S)          = the most positive task performance deviation in S.
//                 Dependencies and project completion time are not used.
// φ_i      = task i's Shapley value = its fairly-weighted average
//            marginal contribution to v(S) across every coalition,
//            i.e. how much of the (actual − planned) deviation is
//            attributable to that task.
//
// This enumerates the full 2^n powerset of coalitions (exact
// Shapley calculation), which is why task count is capped below.
const SHAPLEY_MAX_EXACT_TASKS = 20;   // 2^20 ≈ 1M coalitions — practical ceiling
const SHAPLEY_DEBUG_DETAIL_LIMIT = 10; // keep per-coalition console trace readable

function popcount(x) {
  let c = 0;
  while (x) { c += x & 1; x >>= 1; }
  return c;
}

function computeShapleyValuesDebug(taskList) {
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

  const numCoalitions = 1 << n; // 2^n, including the empty coalition
  const deviations = taskList.map(t => t.actualDuration - t.plannedDuration);

  // ── Characteristic function v(S) ──────────────────────────────────
  // The empty coalition has no performance deviation. A non-empty
  // coalition is valued only by its most positive member deviation.
  function valueOf(mask) {
    if (mask === 0) return 0;

    let mostPositiveDeviation = -Infinity;
    for (let i = 0; i < n; i++) {
      if ((mask & (1 << i)) !== 0 && deviations[i] > mostPositiveDeviation) {
        mostPositiveDeviation = deviations[i];
      }
    }
    return mostPositiveDeviation;
  }

  // Precompute the performance value for every coalition once.
  const vValues = new Array(numCoalitions);
  for (let mask = 0; mask < numCoalitions; mask++) {
    vValues[mask] = valueOf(mask);
  }

  const baseline = vValues[0];
  const fullValue = vValues[numCoalitions - 1];

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

  const totalDeviation = fullValue - baseline;
  const shapleySum = shapley.reduce((a, b) => a + b, 0);

  const results = taskList.map((t, i) => {
    const deviation = deviations[i];
    const shapleyValue = shapley[i];
    const responsibilityPct = totalDeviation !== 0 ? (shapleyValue / totalDeviation) * 100 : 0;
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
    totalDeviation,
    shapleySum,
    baseline,
    fullCoalitionValue: fullValue,
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

// ── Shapley Debug Log Printer 
function printShapleyDebugLog(debugLog) {
  if (!debugLog) return;
  const { n, numCoalitions, baseline, fullValue, detailKept, coalitions, perTask } = debugLog;

  console.group(`Shapley Value Analysis — ${n} tasks, ${numCoalitions} coalitions`);
  console.log(`Empty coalition v(∅):               ${baseline}`);
  console.log(`Full coalition v(N) [max deviation]: ${fullValue}`);
  console.log(`Coalition deviation v(N) − v(∅):     ${fullValue - baseline}`);

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
