"use strict";

// ═════════════════════════════════════════════════════════════════
// Shapley Value Calculator for Schedule Analysis
// ═════════════════════════════════════════════════════════════════
// Players  = DELAYED tasks only, i.e. tasks where actualDuration >
//            plannedDuration. Tasks that finished on time or early
//            are not part of the coalition game at all — they are
//            simply fixed at their actualDuration in every CPM pass,
//            since the question being answered is "which late tasks
//            are responsible for the project running long", and a
//            task that wasn't late can't be responsible for lateness.
// Baseline = v(∅): every delayed task reverts to its plannedDuration,
//            every non-delayed task stays at its actualDuration.
// v(S)     = project completion time when every delayed task in
//            coalition S runs at its ACTUAL duration, every delayed
//            task outside S runs at its PLANNED duration, and every
//            non-delayed task always runs at its ACTUAL duration —
//            with dependencies/order always respected via a single
//            forward CPM pass.
// φ_i      = task i's Shapley value (i ranging only over delayed
//            tasks) = its fairly-weighted average marginal
//            contribution to v(S) across every coalition of delayed
//            tasks, i.e. how much of the (actual − planned) deviation
//            is attributable to that task. Non-delayed tasks are not
//            scored and are reported with a Shapley value of 0.
//
// This enumerates the full 2^n powerset of coalitions of delayed
// tasks (exact Shapley calculation), which is why the delayed-task
// count is capped below.
const SHAPLEY_MAX_EXACT_TASKS = 20;   // 2^20 ≈ 1M coalitions — practical ceiling
const SHAPLEY_DEBUG_DETAIL_LIMIT = 10; // keep per-coalition console trace readable

function popcount(x) {
  let c = 0;
  while (x) { c += x & 1; x >>= 1; }
  return c;
}

function computeShapleyValuesDebug(taskList, plannedProjectDuration) {
  const total = taskList.length;
  if (total === 0) return null;
  if (taskList.some(t => t.actualDuration === null)) return null;

  const order = topologicalSort(taskList);
  if (!order) return null; // circular dependency — caller already guards this too

  // Map each task to its array index (needed for CPM regardless of
  // whether it's a player), and figure out which tasks are actually
  // delayed — those are the only ones that become Shapley players.
  const idToIndex = {};
  taskList.forEach((t, i) => { idToIndex[t.id] = i; });
  const predIndices = taskList.map(t =>
    t.predecessors.map(pid => idToIndex[pid]).filter(idx => idx !== undefined)
  );
  const orderIdx = order.map(id => idToIndex[id]);

  const playerIndices = []; // original taskList indices, one per bit position
  const bitOf = new Array(total).fill(-1);
  taskList.forEach((t, i) => {
    if (t.actualDuration > t.plannedDuration) {
      bitOf[i] = playerIndices.length;
      playerIndices.push(i);
    }
  });
  const n = playerIndices.length; // number of Shapley players (delayed tasks)

  if (n > SHAPLEY_MAX_EXACT_TASKS) {
    console.warn(
      `[Shapley] Skipped: ${n} delayed tasks would require evaluating 2^${n} coalitions, ` +
      `which is impractical to compute exactly. Exact analysis currently supports ` +
      `up to ${SHAPLEY_MAX_EXACT_TASKS} delayed tasks.`
    );
    return null;
  }

  const numCoalitions = 1 << n; // 2^n, including the empty coalition of delayed tasks

  // ── Characteristic function v(S) ──────────────────────────────────
  // One forward CPM pass: a delayed task uses actualDuration if its
  // bit is set in `mask`, otherwise plannedDuration. A non-delayed
  // task always uses actualDuration, since it isn't part of the game.
  // Returns project duration (the longest path / max early-finish,
  // same definition computeCPM and computeActualDuration use).
  const efScratch = new Array(total);
  function valueOf(mask) {
    for (let k = 0; k < orderIdx.length; k++) {
      const idx = orderIdx[k];
      const preds = predIndices[idx];
      let es = 0;
      for (let p = 0; p < preds.length; p++) {
        if (efScratch[preds[p]] > es) es = efScratch[preds[p]];
      }
      const bit = bitOf[idx];
      let dur;
      if (bit === -1) {
        dur = taskList[idx].actualDuration; // non-delayed: always actual
      } else {
        const usesActual = (mask & (1 << bit)) !== 0;
        dur = usesActual ? taskList[idx].actualDuration : taskList[idx].plannedDuration;
      }
      efScratch[idx] = es + dur;
    }
    let maxEf = 0;
    for (let i = 0; i < total; i++) if (efScratch[i] > maxEf) maxEf = efScratch[i];
    return maxEf;
  }

  // Precompute v(S) for every one of the 2^n coalitions of delayed tasks.
  const vValues = new Array(numCoalitions);
  for (let mask = 0; mask < numCoalitions; mask++) {
    vValues[mask] = valueOf(mask);
  }
  const baseline = vValues[0];               // v(∅): all delayed tasks at planned
  const fullValue = vValues[numCoalitions - 1]; // v(N): all delayed tasks at actual

  if (round(baseline) !== round(plannedProjectDuration)) {
    console.warn(
      `[Shapley] Baseline mismatch: coalition-based v(∅)=${baseline} vs ` +
      `supplied plannedProjectDuration=${plannedProjectDuration}. This is expected ` +
      `when non-delayed tasks deviate from plan (they're fixed at actual, not ` +
      `planned, in v(∅)). Using v(∅).`
    );
  }

  // Factorials for the standard Shapley weighting: |S|!(n-|S|-1)!/n!
  const fact = [1];
  for (let i = 1; i <= n; i++) fact[i] = fact[i - 1] * i;
  const nFact = fact[n];

  const shapley = new Array(n).fill(0);
  const keepDetail = n <= SHAPLEY_DEBUG_DETAIL_LIMIT;

  // Full coalition list (of delayed tasks only), for the debug trace.
  let coalitionLog = null;
  if (keepDetail) {
    coalitionLog = [];
    for (let mask = 0; mask < numCoalitions; mask++) {
      const members = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) members.push(taskList[playerIndices[i]].name);
      coalitionLog.push({
        mask,
        members,
        value: vValues[mask],
        deltaFromBaseline: vValues[mask] - baseline
      });
    }
  }

  const perTaskLog = playerIndices.map(idx => ({
    taskId: taskList[idx].id,
    taskName: taskList[idx].name,
    marginalContributions: keepDetail ? [] : null
  }));

  // For every coalition T (of delayed tasks) that contains player i,
  // S = T \ {i} is the coalition "before" i joins. The marginal
  // contribution v(T) - v(S) is weighted by |S|!(n-|S|-1)!/n! and
  // accumulated into φ_i.
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
        for (let k = 0; k < n; k++) if (sMask & (1 << k)) sMembers.push(taskList[playerIndices[k]].name);
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

  const actualDuration = valueOf(numCoalitions - 1); // same as fullValue, kept for clarity
  const totalDelay = actualDuration - baseline;
  const shapleySum = shapley.reduce((a, b) => a + b, 0);

  const results = taskList.map((t, idx) => {
    const deviation = t.actualDuration - t.plannedDuration;
    const bit = bitOf[idx];
    const shapleyValue = bit === -1 ? 0 : shapley[bit];
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
      totalTasks: total,
      nonPlayerTasks: total - n,
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
  const { n, totalTasks, nonPlayerTasks, numCoalitions, baseline, fullValue, detailKept, coalitions, perTask } = debugLog;

  console.group(`Shapley Value Analysis — ${n} delayed task(s) of ${totalTasks} total, ${numCoalitions} coalitions`);
  if (nonPlayerTasks > 0) {
    console.log(`(${nonPlayerTasks} on-time/early task(s) excluded from the game, fixed at actual duration.)`);
  }
  console.log(`Baseline v(∅) [delayed→planned, others→actual]: ${baseline}`);
  console.log(`Full coalition v(N) [all delayed→actual]:        ${fullValue}`);
  console.log(`Total deviation v(N) − v(∅):                      ${fullValue - baseline}`);

  if (detailKept && coalitions) {
    console.group("All coalitions S (of delayed tasks) and their value v(S)");
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