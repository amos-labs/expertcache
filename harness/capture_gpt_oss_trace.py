#!/usr/bin/env python3
"""Capture privacy-safe GPT-OSS expert selections for ExpertCache simulation."""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Router hooks need the ordinary PyTorch module to run. Hub kernels can replace
# GptOssMLP.forward and bypass GptOssTopKRouter entirely.
os.environ.setdefault("USE_HUB_KERNELS", "0")

TRACE_SCHEMA = "amos.expert-routing-trace"
TRACE_VERSION = 1
DEFAULT_MODEL = "openai/gpt-oss-120b"
DEFAULT_MODEL_REVISION = "b5c939de8f754692c1647ca79fbf85e8c1e70f8a"
TRANSFORMERS_REVISION = "ff24c90cdda4b620327e8b4168692729289ce477"
SAFE_LABEL = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
ALLOWED_INPUT_KEYS = {"trace_id", "workflow", "messages"}
ALLOWED_MESSAGE_KEYS = {"role", "content"}
ALLOWED_ROLES = {"system", "user", "assistant"}
SENTINEL = object()


@dataclass(frozen=True)
class PromptCase:
    trace_id: str
    workflow: str
    messages: list[dict[str, str]]


class JsonlTraceWriter:
    """Bounded asynchronous JSONL writer that never records model text."""

    def __init__(self, output: Path, metadata: dict[str, Any], queue_size: int):
        self.output = output
        self.partial = output.with_suffix(output.suffix + ".partial")
        self.summary = output.with_suffix(output.suffix + ".summary.json")
        self.queue: queue.Queue[object] = queue.Queue(maxsize=queue_size)
        self.dropped_records = 0
        self.written_records = 0
        self._error: BaseException | None = None
        self._thread = threading.Thread(
            target=self._write_loop,
            args=(metadata,),
            name="expert-trace-writer",
            daemon=True,
        )
        output.parent.mkdir(parents=True, exist_ok=True)
        self._thread.start()

    def submit(self, record: dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(record)
        except queue.Full:
            self.dropped_records += 1

    def close(self, *, completed_cases: int, captured_tokens: int) -> None:
        self.queue.put(SENTINEL)
        self._thread.join()
        if self._error is not None:
            raise RuntimeError("Expert trace writer failed") from self._error
        if self.dropped_records == 0:
            self.partial.replace(self.output)
        self.summary.write_text(
            json.dumps(
                {
                    "schema": "amos.expert-routing-trace-summary",
                    "version": 1,
                    "completed_cases": completed_cases,
                    "captured_tokens": captured_tokens,
                    "written_records": self.written_records,
                    "dropped_records": self.dropped_records,
                    "complete": self.dropped_records == 0,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    def abort(self) -> None:
        self.queue.put(SENTINEL)
        self._thread.join()

    def _write_loop(self, metadata: dict[str, Any]) -> None:
        try:
            with self.partial.open("w", encoding="utf-8") as handle:
                handle.write(json.dumps(metadata, separators=(",", ":")) + "\n")
                while True:
                    record = self.queue.get()
                    if record is SENTINEL:
                        break
                    handle.write(json.dumps(record, separators=(",", ":")) + "\n")
                    self.written_records += 1
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException as error:  # surfaced on close/abort
            self._error = error


class RouterCapture:
    """Collect complete per-forward router selections from one-sample runs."""

    def __init__(
        self,
        model: Any,
        writer: JsonlTraceWriter,
        *,
        expected_layers: int,
        active_experts: int,
    ):
        self.writer = writer
        self.expected_layers = expected_layers
        self.active_experts = active_experts
        self.handles: list[Any] = []
        self.pending: dict[int, list[list[int]]] = {}
        self.trace_id = ""
        self.workflow = ""
        self.forward_index = 0
        self.token_index = 0
        self.captured_tokens = 0

        routers = [
            (name, module)
            for name, module in model.named_modules()
            if module.__class__.__name__ == "GptOssTopKRouter"
        ]
        if len(routers) != expected_layers:
            raise RuntimeError(
                f"Expected {expected_layers} GPT-OSS routers, discovered {len(routers)}. "
                "The pinned tracing runtime or model architecture changed."
            )
        for layer_index, (name, module) in enumerate(routers):
            self.handles.append(
                module.register_forward_hook(self._hook(layer_index, name))
            )

    def begin_case(self, case: PromptCase) -> None:
        if self.pending:
            raise RuntimeError("Router capture began a case with an incomplete forward pass")
        self.trace_id = case.trace_id
        self.workflow = case.workflow
        self.forward_index = 0
        self.token_index = 0

    def end_case(self) -> None:
        if self.pending:
            missing = sorted(set(range(self.expected_layers)) - set(self.pending))
            raise RuntimeError(f"Incomplete router forward; missing layers {missing}")
        self.trace_id = ""
        self.workflow = ""

    def close(self) -> None:
        for handle in self.handles:
            handle.remove()
        self.handles.clear()

    def _hook(self, layer_index: int, module_name: str):
        def capture(_module: Any, _inputs: Any, output: Any) -> None:
            if not self.trace_id:
                raise RuntimeError("Router executed outside an active trace case")
            if layer_index in self.pending:
                raise RuntimeError(
                    f"Router {module_name} executed twice before a forward completed"
                )
            if not isinstance(output, (tuple, list)) or len(output) < 3:
                raise RuntimeError(
                    f"Router {module_name} did not expose (logits, scores, indices). "
                    "Ensure USE_HUB_KERNELS=0 and use the pinned Transformers revision."
                )
            indices = output[2]
            if getattr(indices, "ndim", None) != 2:
                raise RuntimeError(
                    f"Router {module_name} produced unexpected index shape "
                    f"{getattr(indices, 'shape', None)}"
                )
            selected = indices.detach().to(device="cpu").tolist()
            if any(len(experts) != self.active_experts for experts in selected):
                raise RuntimeError(
                    f"Router {module_name} did not select top-{self.active_experts}"
                )
            self.pending[layer_index] = selected
            if len(self.pending) == self.expected_layers:
                self._flush_forward()

        return capture

    def _flush_forward(self) -> None:
        ordered = [self.pending[layer] for layer in range(self.expected_layers)]
        token_count = len(ordered[0])
        if token_count == 0 or any(len(layer) != token_count for layer in ordered):
            raise RuntimeError("GPT-OSS routers disagreed about forward token count")
        phase = "prefill" if self.forward_index == 0 else "decode"
        for position in range(token_count):
            self.writer.submit(
                {
                    "type": "token",
                    "trace_id": self.trace_id,
                    "token_index": self.token_index,
                    "phase": phase,
                    "workflow": self.workflow,
                    "experts": [
                        [int(expert) for expert in layer[position]]
                        for layer in ordered
                    ],
                }
            )
            self.token_index += 1
            self.captured_tokens += 1
        self.pending.clear()
        self.forward_index += 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Capture GPT-OSS router selections without recording prompts or generated text."
        )
    )
    parser.add_argument("--input", required=True, type=Path, help="Safe prompt JSONL")
    parser.add_argument("--output", required=True, type=Path, help="Routing trace JSONL")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--revision", default=DEFAULT_MODEL_REVISION)
    parser.add_argument("--expert-bytes", required=True, type=int)
    parser.add_argument("--weight-store-bytes", type=int)
    parser.add_argument("--shared-resident-bytes", type=int, default=0)
    parser.add_argument("--max-new-tokens", type=int, default=128)
    parser.add_argument("--device-map", default="auto")
    parser.add_argument("--queue-size", type=int, default=8192)
    parser.add_argument(
        "--capture-mode",
        choices=("greedy", "sampled"),
        default="greedy",
        help="Greedy is reproducible; sampled captures production-like routing variance.",
    )
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--top-p", type=float, default=0.95)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--samples-per-case",
        type=int,
        default=1,
        help="Independent sampled generations per corpus case.",
    )
    parser.add_argument(
        "--acknowledge-safe-input",
        action="store_true",
        help="Confirm the input is synthetic, public, or explicitly approved for benchmarking.",
    )
    return parser.parse_args()


def load_cases(path: Path) -> list[PromptCase]:
    cases: list[PromptCase] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, raw in enumerate(handle, start=1):
            if not raw.strip():
                continue
            try:
                record = json.loads(raw)
            except json.JSONDecodeError as error:
                raise ValueError(f"Input line {line_number} is invalid JSON") from error
            if not isinstance(record, dict):
                raise ValueError(f"Input line {line_number} must be an object")
            unknown = set(record) - ALLOWED_INPUT_KEYS
            if unknown:
                raise ValueError(
                    f"Input line {line_number} has unsupported fields: {sorted(unknown)}"
                )
            trace_id = validate_label(record.get("trace_id"), "trace_id", line_number)
            workflow = validate_label(record.get("workflow"), "workflow", line_number)
            messages = record.get("messages")
            if not isinstance(messages, list) or not messages:
                raise ValueError(f"Input line {line_number} needs non-empty messages")
            normalized_messages: list[dict[str, str]] = []
            for message_index, message in enumerate(messages):
                if not isinstance(message, dict):
                    raise ValueError(
                        f"Input line {line_number} message {message_index} must be an object"
                    )
                unknown_message = set(message) - ALLOWED_MESSAGE_KEYS
                if unknown_message:
                    raise ValueError(
                        f"Input line {line_number} message {message_index} has "
                        f"unsupported fields: {sorted(unknown_message)}"
                    )
                role = message.get("role")
                content = message.get("content")
                if role not in ALLOWED_ROLES:
                    raise ValueError(
                        f"Input line {line_number} message {message_index} has invalid role"
                    )
                if not isinstance(content, str) or not content.strip():
                    raise ValueError(
                        f"Input line {line_number} message {message_index} needs content"
                    )
                normalized_messages.append({"role": role, "content": content})
            cases.append(PromptCase(trace_id, workflow, normalized_messages))
    if not cases:
        raise ValueError("Input corpus contains no prompt cases")
    return cases


def validate_label(value: Any, field: str, line_number: int) -> str:
    if not isinstance(value, str) or not SAFE_LABEL.fullmatch(value):
        raise ValueError(
            f"Input line {line_number} {field} must match {SAFE_LABEL.pattern}"
        )
    return value


def positive(value: int, name: str) -> int:
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def sampled_trace_id(base: str, sample_index: int) -> str:
    suffix = f"-s{sample_index + 1:02d}"
    return f"{base[: 64 - len(suffix)]}{suffix}"


def main() -> int:
    args = parse_args()
    if not args.acknowledge_safe_input:
        print(
            "Refusing to load prompts without --acknowledge-safe-input. "
            "Use only synthetic, public, or explicitly approved benchmark data.",
            file=sys.stderr,
        )
        return 2
    positive(args.expert_bytes, "expert-bytes")
    positive(args.max_new_tokens, "max-new-tokens")
    positive(args.queue_size, "queue-size")
    positive(args.samples_per_case, "samples-per-case")
    if args.capture_mode == "greedy" and args.samples_per_case != 1:
        raise ValueError("Greedy capture requires --samples-per-case 1")
    if args.temperature <= 0:
        raise ValueError("temperature must be positive")
    if not 0 < args.top_p <= 1:
        raise ValueError("top-p must be greater than 0 and at most 1")
    if args.seed < 0:
        raise ValueError("seed cannot be negative")
    if args.weight_store_bytes is not None:
        positive(args.weight_store_bytes, "weight-store-bytes")
    if args.shared_resident_bytes < 0:
        raise ValueError("shared-resident-bytes cannot be negative")
    cases = load_cases(args.input)

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(
        args.model,
        revision=args.revision,
        trust_remote_code=False,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        revision=args.revision,
        dtype="auto",
        device_map=args.device_map,
        low_cpu_mem_usage=True,
        trust_remote_code=False,
        use_kernels=False,
    )
    model.eval()
    config = model.config
    layers = int(config.num_hidden_layers)
    experts_per_layer = int(config.num_local_experts)
    active_experts = int(config.num_experts_per_tok)
    metadata = {
        "type": "metadata",
        "schema": TRACE_SCHEMA,
        "version": TRACE_VERSION,
        "model": args.model,
        "layers": layers,
        "experts_per_layer": experts_per_layer,
        "active_experts": active_experts,
        "expert_bytes": args.expert_bytes,
        "shared_resident_bytes": args.shared_resident_bytes,
        "source_revision": (
            f"model:{args.revision};transformers:{TRANSFORMERS_REVISION}"
        ),
        "capture_mode": args.capture_mode,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if args.capture_mode == "sampled":
        metadata["sampling_temperature"] = args.temperature
        metadata["sampling_top_p"] = args.top_p
        metadata["sampling_seed"] = args.seed
    if args.weight_store_bytes is not None:
        metadata["weight_store_bytes"] = args.weight_store_bytes

    writer = JsonlTraceWriter(args.output, metadata, args.queue_size)
    capture = RouterCapture(
        model,
        writer,
        expected_layers=layers,
        active_experts=active_experts,
    )
    completed_cases = 0
    try:
        input_device = model.get_input_embeddings().weight.device
        for case in cases:
            for sample_index in range(args.samples_per_case):
                run_case = (
                    case
                    if args.capture_mode == "greedy"
                    else PromptCase(
                        sampled_trace_id(case.trace_id, sample_index),
                        case.workflow,
                        case.messages,
                    )
                )
                capture.begin_case(run_case)
                encoded = tokenizer.apply_chat_template(
                    run_case.messages,
                    add_generation_prompt=True,
                    tokenize=True,
                    return_tensors="pt",
                    return_dict=True,
                )
                encoded = {key: value.to(input_device) for key, value in encoded.items()}
                torch.manual_seed(args.seed + completed_cases)
                generation = {
                    "do_sample": args.capture_mode == "sampled",
                    "max_new_tokens": args.max_new_tokens,
                    "pad_token_id": tokenizer.eos_token_id,
                }
                if args.capture_mode == "sampled":
                    generation["temperature"] = args.temperature
                    generation["top_p"] = args.top_p
                with torch.inference_mode():
                    model.generate(**encoded, **generation)
                capture.end_case()
                completed_cases += 1
        writer.close(
            completed_cases=completed_cases,
            captured_tokens=capture.captured_tokens,
        )
    except BaseException:
        writer.abort()
        raise
    finally:
        capture.close()

    if writer.dropped_records:
        print(
            f"Trace incomplete: dropped {writer.dropped_records} records. "
            "Increase --queue-size and rerun.",
            file=sys.stderr,
        )
        return 1
    print(
        f"Captured {capture.captured_tokens} routing tokens from "
        f"{completed_cases} cases into {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
