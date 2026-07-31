#!/usr/bin/env python3
"""Build a privacy-safe expert byte-range layout from one or more GGUF shards."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LAYOUT_SCHEMA = "amos.expert-byte-layout"
LAYOUT_VERSION = 1
EXPERT_TENSOR = re.compile(
    r"^blk\.(?P<layer>\d+)\.ffn_(?:gate|up|down|gate_up)_exps\.weight$"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Map GGUF MoE expert tensors to exact file byte ranges."
    )
    parser.add_argument(
        "--gguf",
        action="append",
        required=True,
        help="GGUF file or shard. Repeat for split models.",
    )
    parser.add_argument("--output", required=True, help="Layout JSON output path.")
    parser.add_argument(
        "--model",
        default="",
        help="Display model identifier. Defaults to the first GGUF filename.",
    )
    parser.add_argument(
        "--source-revision",
        required=True,
        help="Pinned llama.cpp/runtime revision used to inspect the model.",
    )
    parser.add_argument(
        "--gguf-python",
        default=os.environ.get("LLAMA_CPP_GGUF_PY", ""),
        help="Path to llama.cpp/gguf-py when gguf is not installed.",
    )
    return parser.parse_args()


def load_reader(gguf_python: str):
    if gguf_python:
        sys.path.insert(0, str(Path(gguf_python).expanduser().resolve()))
    try:
        from gguf import GGUFReader  # type: ignore
    except ImportError as error:
        raise SystemExit(
            "Could not import gguf.GGUFReader. Pass --gguf-python "
            "/path/to/llama.cpp/gguf-py."
        ) from error
    return GGUFReader


def build_layout(
    paths: list[Path],
    *,
    model: str,
    source_revision: str,
    reader_type: Any,
) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    experts: dict[int, dict[int, list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    layer_counts: dict[int, int] = {}
    tensor_count = 0

    for file_index, path in enumerate(paths):
        resolved = path.expanduser().resolve()
        if not resolved.is_file():
            raise ValueError(f"GGUF file does not exist: {resolved}")
        file_id = f"file-{file_index}"
        files.append(
            {
                "id": file_id,
                "path": str(resolved),
                "size_bytes": resolved.stat().st_size,
            }
        )
        reader = reader_type(str(resolved), "r")
        for tensor in reader.tensors:
            match = EXPERT_TENSOR.match(tensor.name)
            if not match:
                continue
            layer = int(match.group("layer"))
            shape = [int(value) for value in tensor.shape.tolist()]
            if len(shape) < 3:
                raise ValueError(
                    f"Expert tensor {tensor.name} has unexpected shape {shape}"
                )
            expert_count = shape[-1]
            if expert_count <= 0 or tensor.n_bytes % expert_count != 0:
                raise ValueError(
                    f"Expert tensor {tensor.name} cannot be split evenly across "
                    f"{expert_count} experts"
                )
            previous = layer_counts.setdefault(layer, expert_count)
            if previous != expert_count:
                raise ValueError(
                    f"Layer {layer} mixes {previous} and {expert_count} experts"
                )
            expert_bytes = tensor.n_bytes // expert_count
            for expert in range(expert_count):
                experts[layer][expert].append(
                    {
                        "file_id": file_id,
                        "tensor": tensor.name,
                        "offset": int(tensor.data_offset + expert * expert_bytes),
                        "length": int(expert_bytes),
                    }
                )
            tensor_count += 1

    if not experts:
        raise ValueError("No ffn_*_exps.weight tensors were found in the GGUF input")

    layers: list[dict[str, Any]] = []
    expected_layers = list(range(min(experts), max(experts) + 1))
    if sorted(experts) != expected_layers:
        raise ValueError(
            f"Router-bearing layers are not contiguous: {sorted(experts)}"
        )
    for layer in sorted(experts):
        expected_experts = set(range(layer_counts[layer]))
        actual_experts = set(experts[layer])
        if actual_experts != expected_experts:
            missing = sorted(expected_experts - actual_experts)
            raise ValueError(f"Layer {layer} is missing expert ranges: {missing}")
        layers.append(
            {
                "layer": layer,
                "expert_count": layer_counts[layer],
                "experts": [
                    {
                        "expert": expert,
                        "ranges": experts[layer][expert],
                        "bytes": sum(
                            item["length"] for item in experts[layer][expert]
                        ),
                    }
                    for expert in range(layer_counts[layer])
                ],
            }
        )

    first_expert_bytes = layers[0]["experts"][0]["bytes"]
    if any(
        expert["bytes"] != first_expert_bytes
        for layer in layers
        for expert in layer["experts"]
    ):
        raise ValueError("Expert byte footprints differ across the model")

    return {
        "schema": LAYOUT_SCHEMA,
        "version": LAYOUT_VERSION,
        "model": model or paths[0].name,
        "source_revision": source_revision,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "page_size": os.sysconf("SC_PAGE_SIZE"),
        "layer_count": len(layers),
        "experts_per_layer": layers[0]["expert_count"],
        "bytes_per_layer_expert": first_expert_bytes,
        "expert_tensor_count": tensor_count,
        "files": files,
        "layers": layers,
    }


def main() -> int:
    args = parse_args()
    reader_type = load_reader(args.gguf_python)
    layout = build_layout(
        [Path(value) for value in args.gguf],
        model=args.model,
        source_revision=args.source_revision,
        reader_type=reader_type,
    )
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(layout, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "output": str(output),
                "layers": layout["layer_count"],
                "experts_per_layer": layout["experts_per_layer"],
                "bytes_per_layer_expert": layout["bytes_per_layer_expert"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
