# Hosted GPT-OSS control

The hosted control runs the same public qualification harness against Amazon
Bedrock's GPT-OSS 120B endpoint. It tests provider behavior under matched
requested reasoning effort, seed, completion cap, prompts, tools, and
evaluators. It is not a latency comparison with local inference and does not
establish bit-exact output.

## Start the local translation gateway

Use AWS credentials that can invoke the selected Bedrock model. The gateway
binds to loopback by default and forwards OpenAI-shaped benchmark requests to
the Bedrock Converse API.

```bash
python3 -m venv .venv-bedrock
source .venv-bedrock/bin/activate
python -m pip install -r harness/requirements-bedrock.txt
python scripts/bedrockBenchmarkGateway.py \
  --region us-east-1 \
  --model openai.gpt-oss-120b-1:0
```

The gateway passes `reasoning_effort` and `seed` through
`additionalModelRequestFields`. A control run that omits either field is
provider-default evidence and must not be described as configuration parity.

## Run the disclosed qualification suite

```bash
node scripts/benchmarkLocalModels.js openai.gpt-oss-120b-1:0 \
  --protocol openai \
  --url http://127.0.0.1:11440 \
  --suite qualification \
  --context 8192 \
  --max-tokens 1536 \
  --reasoning-effort low \
  --seed 42 \
  --request-timeout-seconds 7200 \
  --output output/hosted-control/bedrock-low-seed42.json
```

Repeat with `--reasoning-effort medium` for the matched medium control. Keep
each report immutable and record the model identifier, region, date, and
gateway source revision. Do not combine scores across efforts or use hosted
wall time as a local runtime speed result.
