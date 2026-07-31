import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeExpertRouteUnions,
  parseExpertRouteLog
} from "../src/expertRouteUnions.js";

test("route-union analysis measures expert reuse across token windows", () => {
  const log = [
    line(0, [0, 1]),
    line(1, [2, 3]),
    line(0, [0, 2]),
    line(1, [2, 4]),
    line(0, [0, 1]),
    line(1, [3, 4])
  ].join("\n");
  const trace = parseExpertRouteLog(log);
  const report = analyzeExpertRouteUnions(trace, {
    windows: [1, 2, 3],
    expertBytes: 1024
  });

  assert.equal(report.observed_route_steps, 3);
  assert.equal(report.layer_count, 2);
  assert.equal(report.active_experts_per_token, 2);
  assert.deepEqual(
    report.analyses.map((analysis) => analysis.window_tokens),
    [1, 2, 3]
  );
  assert.equal(report.analyses[1].experts_per_layer.max, 3);
  assert.equal(report.analyses[2].experts_per_layer.mean, 3);
  assert.ok(report.analyses[2].route_reuse_rate > 0);
});

function line(layer, experts) {
  return (
    `I ExpertCache stage tensor='blk.${layer}.ffn_gate_exps.weight' ` +
    `tokens=1 routes=${experts.length} unique=${new Set(experts).size} ` +
    `bytes=100 elapsed_ms=1.0 ids=[${experts.join(",")}]`
  );
}
