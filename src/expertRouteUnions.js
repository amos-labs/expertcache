const GIB = 1024 ** 3;

export function parseExpertRouteLog(text) {
  const pattern =
    /tensor='blk\.(\d+)\.ffn_gate_exps\.weight'\s+tokens=(\d+)\s+routes=(\d+)\s+unique=(\d+).*?\sids=\[([^\]]*)\]/;
  const steps = [];
  let current = null;

  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }
    const layer = Number(match[1]);
    const tokenCount = Number(match[2]);
    const routes = Number(match[3]);
    const reportedUnique = Number(match[4]);
    const experts = match[5]
      .split(",")
      .map((value) => Number(value.trim()))
      .filter(Number.isInteger);

    if (layer === 0) {
      if (current) {
        steps.push(current);
      }
      current = {
        tokenCount,
        routes,
        layers: new Map()
      };
    }
    if (!current) {
      throw new Error(`Expert trace begins at layer ${layer}, not layer 0`);
    }
    if (current.layers.has(layer)) {
      throw new Error(`Duplicate gate route for layer ${layer} in one step`);
    }
    const uniqueExperts = [...new Set(experts)];
    if (uniqueExperts.length !== reportedUnique) {
      throw new Error(
        `Layer ${layer} reported ${reportedUnique} unique experts but logged ` +
        `${uniqueExperts.length}`
      );
    }
    current.layers.set(layer, uniqueExperts);
  }

  if (current) {
    steps.push(current);
  }
  if (steps.length === 0) {
    throw new Error("No ExpertCache gate routes found in the log");
  }

  const layers = [...steps[0].layers.keys()].sort((a, b) => a - b);
  for (const [index, step] of steps.entries()) {
    const stepLayers = [...step.layers.keys()].sort((a, b) => a - b);
    if (
      stepLayers.length !== layers.length ||
      stepLayers.some((layer, layerIndex) => layer !== layers[layerIndex])
    ) {
      throw new Error(
        `Step ${index} has an incomplete or inconsistent layer set`
      );
    }
  }

  return {
    steps,
    layers
  };
}

export function analyzeExpertRouteUnions(
  trace,
  {
    windows = [1, 2, 4, 8, 16, 32, 64],
    expertBytes = 13_219_200
  } = {}
) {
  const { steps, layers } = trace;
  const analyses = [];

  for (const requestedWindow of windows) {
    const window = Number(requestedWindow);
    if (!Number.isInteger(window) || window < 1 || window > steps.length) {
      continue;
    }

    const layerUnions = [];
    const residentBytes = [];
    const windowMaximums = [];
    const selectionsPerLayer = [];

    for (let start = 0; start <= steps.length - window; start += 1) {
      let totalExperts = 0;
      let maximumExperts = 0;
      for (const layer of layers) {
        const union = new Set();
        let selections = 0;
        for (let offset = 0; offset < window; offset += 1) {
          const experts = steps[start + offset].layers.get(layer);
          selections += experts.length;
          for (const expert of experts) {
            union.add(expert);
          }
        }
        const unique = union.size;
        layerUnions.push(unique);
        selectionsPerLayer.push(selections);
        totalExperts += unique;
        maximumExperts = Math.max(maximumExperts, unique);
      }
      residentBytes.push(totalExperts * expertBytes);
      windowMaximums.push(maximumExperts);
    }

    const totalSelections = selectionsPerLayer.reduce(
      (total, value) => total + value,
      0
    );
    const totalUnique = layerUnions.reduce(
      (total, value) => total + value,
      0
    );
    analyses.push({
      window_tokens: window,
      sliding_windows: steps.length - window + 1,
      experts_per_layer: summarize(layerUnions),
      max_experts_in_any_layer_per_window: summarize(windowMaximums),
      full_model_working_set_gib: summarize(
        residentBytes.map((value) => value / GIB)
      ),
      route_reuse_rate: totalSelections > 0
        ? 1 - totalUnique / totalSelections
        : 0
    });
  }

  return {
    schema: "amos.expert-route-union-analysis",
    version: 1,
    observed_route_steps: steps.length,
    observed_tokens: steps.reduce(
      (total, step) => total + step.tokenCount,
      0
    ),
    layer_count: layers.length,
    active_experts_per_token: steps[0].routes / steps[0].tokenCount,
    expert_bytes_across_projections: expertBytes,
    analyses
  };
}

function summarize(values) {
  if (values.length === 0) {
    return {
      mean: 0,
      p50: 0,
      p95: 0,
      max: 0
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    mean: total / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1)
  };
}

function percentile(sorted, fraction) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  );
  return sorted[index];
}
