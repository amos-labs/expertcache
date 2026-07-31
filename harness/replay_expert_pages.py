#!/usr/bin/env python3
"""Replay ExpertCache traces against real GGUF byte ranges using mmap pages."""

from __future__ import annotations

import argparse
import ctypes
import json
import math
import mmap
import os
import resource
import statistics
import time
from collections import Counter, OrderedDict, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np

TRACE_SCHEMA = "amos.expert-routing-trace"
LAYOUT_SCHEMA = "amos.expert-byte-layout"
REPORT_SCHEMA = "amos.expert-page-replay"
REPORT_VERSION = 1


@dataclass(frozen=True)
class ByteRange:
    file_id: str
    offset: int
    length: int


@dataclass
class AccessDecision:
    hit: bool
    admitted: bool
    evicted: list[tuple[int, int]]


class LruPolicy:
    def __init__(self, capacity: int, admit_after: int):
        self.capacity = capacity
        self.admit_after = admit_after
        self.entries: OrderedDict[tuple[int, int], None] = OrderedDict()
        self.frequency: Counter[tuple[int, int]] = Counter()

    def access(self, key: tuple[int, int]) -> AccessDecision:
        if key in self.entries:
            self.entries.move_to_end(key)
            return AccessDecision(True, True, [])
        self.frequency[key] += 1
        if self.frequency[key] < self.admit_after:
            return AccessDecision(False, False, [])
        evicted: list[tuple[int, int]] = []
        self.entries[key] = None
        if len(self.entries) > self.capacity:
            evicted.append(self.entries.popitem(last=False)[0])
        return AccessDecision(False, True, evicted)

    def resident_keys(self) -> set[tuple[int, int]]:
        return set(self.entries)


class SlruPolicy:
    def __init__(self, capacity: int, admit_after: int):
        self.capacity = capacity
        self.admit_after = admit_after
        self.probation_capacity = min(
            capacity, max(2, int(math.ceil(capacity * 0.2)))
        )
        self.protected_capacity = max(0, capacity - self.probation_capacity)
        self.probation: OrderedDict[tuple[int, int], None] = OrderedDict()
        self.protected: OrderedDict[tuple[int, int], None] = OrderedDict()
        self.frequency: Counter[tuple[int, int]] = Counter()

    def access(self, key: tuple[int, int]) -> AccessDecision:
        if key in self.protected:
            self.protected.move_to_end(key)
            return AccessDecision(True, True, [])
        if key in self.probation:
            del self.probation[key]
            evicted: list[tuple[int, int]] = []
            if self.protected_capacity > 0:
                self.protected[key] = None
                if len(self.protected) > self.protected_capacity:
                    demoted, _ = self.protected.popitem(last=False)
                    self.probation[demoted] = None
            else:
                self.probation[key] = None
            evicted.extend(self._trim_probation())
            return AccessDecision(True, True, evicted)
        self.frequency[key] += 1
        if self.frequency[key] < self.admit_after:
            return AccessDecision(False, False, [])
        self.probation[key] = None
        return AccessDecision(False, True, self._trim_probation())

    def _trim_probation(self) -> list[tuple[int, int]]:
        evicted: list[tuple[int, int]] = []
        while len(self.probation) > self.probation_capacity:
            evicted.append(self.probation.popitem(last=False)[0])
        return evicted

    def resident_keys(self) -> set[tuple[int, int]]:
        return set(self.probation) | set(self.protected)


class NaturalPolicy:
    """Unmodified mmap control: observe reuse but never advise or evict pages."""

    def __init__(self):
        self.seen: set[tuple[int, int]] = set()

    def access(self, key: tuple[int, int]) -> AccessDecision:
        hit = key in self.seen
        self.seen.add(key)
        return AccessDecision(hit, True, [])

    def resident_keys(self) -> set[tuple[int, int]]:
        return set(self.seen)


class DisabledPolicy:
    """Hard-off microbenchmark arm: release every touched expert after the token."""

    def access(self, key: tuple[int, int]) -> AccessDecision:
        return AccessDecision(False, False, [])

    def resident_keys(self) -> set[tuple[int, int]]:
        return set()


class LayeredPolicy:
    """Give every router-bearing layer its own bounded slot budget."""

    def __init__(self, factory):
        self.factory = factory
        self.layers: dict[int, Any] = {}

    def access(self, key: tuple[int, int]) -> AccessDecision:
        layer = key[0]
        policy = self.layers.setdefault(layer, self.factory())
        return policy.access(key)

    def resident_keys(self) -> set[tuple[int, int]]:
        return {
            key
            for policy in self.layers.values()
            for key in policy.resident_keys()
        }


class MappedFiles:
    def __init__(self, files: list[dict[str, Any]]):
        self.handles: dict[str, Any] = {}
        self.maps: dict[str, mmap.mmap] = {}
        self.addresses: dict[str, int] = {}
        self.page_size = os.sysconf("SC_PAGE_SIZE")
        self.checksum = 0
        self.madvise_willneed = 0
        self.madvise_dontneed = 0
        self.mincore_calls = 0
        libc = ctypes.CDLL(None, use_errno=True)
        self._mincore = getattr(libc, "mincore", None)
        if self._mincore is not None:
            self._mincore.argtypes = [
                ctypes.c_void_p,
                ctypes.c_size_t,
                ctypes.POINTER(ctypes.c_ubyte),
            ]
            self._mincore.restype = ctypes.c_int
        for item in files:
            handle = open(item["path"], "rb", buffering=0)
            self.handles[item["id"]] = handle
            mapping = mmap.mmap(
                handle.fileno(), length=0, access=mmap.ACCESS_READ
            )
            self.maps[item["id"]] = mapping
            self.addresses[item["id"]] = int(
                np.frombuffer(mapping, dtype=np.uint8, count=1).ctypes.data
            )

    def close(self) -> None:
        for mapping in self.maps.values():
            mapping.close()
        for handle in self.handles.values():
            handle.close()

    def prefetch(self, byte_range: ByteRange) -> None:
        mapping = self.maps[byte_range.file_id]
        if not hasattr(mapping, "madvise") or not hasattr(mmap, "MADV_WILLNEED"):
            return
        start, length = self._aligned(byte_range)
        mapping.madvise(mmap.MADV_WILLNEED, start, length)
        self.madvise_willneed += 1

    def release(self, byte_range: ByteRange) -> None:
        start, length = self._aligned(byte_range)
        self._release_aligned(byte_range.file_id, start, length)

    def release_owned_pages(self, byte_range: ByteRange) -> None:
        """Release only pages fully contained by this byte range.

        Adjacent experts can share the first or last VM page even though their
        tensor byte ranges never overlap. Dropping an outward-aligned range
        would therefore evict bytes that still belong to a resident neighbor.
        """
        start = (
            (byte_range.offset + self.page_size - 1) // self.page_size
        ) * self.page_size
        end = (
            (byte_range.offset + byte_range.length) // self.page_size
        ) * self.page_size
        if end > start:
            self._release_aligned(byte_range.file_id, start, end - start)

    def _release_aligned(self, file_id: str, start: int, length: int) -> None:
        if length <= 0:
            return
        mapping = self.maps[file_id]
        if hasattr(mapping, "madvise") and hasattr(mmap, "MADV_DONTNEED"):
            mapping.madvise(mmap.MADV_DONTNEED, start, length)
            self.madvise_dontneed += 1
            return
        if hasattr(os, "posix_fadvise") and hasattr(os, "POSIX_FADV_DONTNEED"):
            handle = self.handles[file_id]
            os.posix_fadvise(
                handle.fileno(),
                start,
                length,
                os.POSIX_FADV_DONTNEED,
            )
            self.madvise_dontneed += 1

    def release_all(self) -> None:
        for file_id, mapping in self.maps.items():
            self.release(
                ByteRange(file_id=file_id, offset=0, length=len(mapping))
            )

    def residency(self, byte_range: ByteRange) -> tuple[int, int]:
        if self._mincore is None:
            return 0, 0
        start, length = self._aligned(byte_range)
        page_count = int(math.ceil(length / self.page_size))
        vector = (ctypes.c_ubyte * page_count)()
        address = self.addresses[byte_range.file_id] + start
        result = self._mincore(
            ctypes.c_void_p(address),
            ctypes.c_size_t(length),
            vector,
        )
        self.mincore_calls += 1
        if result != 0:
            errno = ctypes.get_errno()
            raise OSError(
                errno,
                f"mincore failed for {byte_range.file_id}:{start}+{length}",
            )
        return sum(1 for value in vector if value & 1), page_count

    def touch(self, byte_range: ByteRange) -> None:
        mapping = self.maps[byte_range.file_id]
        start = byte_range.offset
        end = start + byte_range.length
        if start < 0 or byte_range.length <= 0 or end > len(mapping):
            raise ValueError(
                f"Range {byte_range.file_id}:{start}+{byte_range.length} "
                f"is outside a {len(mapping)} byte mapping"
            )
        pages = np.frombuffer(
            mapping,
            dtype=np.uint8,
            count=byte_range.length,
            offset=start,
        )[:: self.page_size]
        checksum = int(np.bitwise_xor.reduce(pages, initial=np.uint8(0)))
        self.checksum ^= checksum ^ mapping[end - 1]

    def _aligned(self, byte_range: ByteRange) -> tuple[int, int]:
        start = byte_range.offset - (byte_range.offset % self.page_size)
        end = byte_range.offset + byte_range.length
        end = ((end + self.page_size - 1) // self.page_size) * self.page_size
        end = min(end, len(self.maps[byte_range.file_id]))
        return start, end - start


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replay sparse expert selections against real mapped GGUF pages."
    )
    parser.add_argument("--trace", required=True)
    parser.add_argument("--layout", required=True)
    parser.add_argument(
        "--mode",
        choices=("natural", "working-set", "disabled"),
        default="working-set",
    )
    parser.add_argument("--policy", choices=("lru", "slru"), default="slru")
    parser.add_argument("--slots-per-layer", type=int, default=32)
    parser.add_argument("--admit-after", type=int, default=2)
    parser.add_argument(
        "--phase",
        choices=("all", "prefill", "decode"),
        default="all",
        help="Replay all records or only one explicitly labelled trace phase.",
    )
    parser.add_argument(
        "--trace-id",
        action="append",
        default=[],
        help="Replay only this trace id. Repeat to select multiple traces.",
    )
    parser.add_argument(
        "--workflow",
        action="append",
        default=[],
        help="Replay only this workflow. Repeat to select multiple workflows.",
    )
    parser.add_argument(
        "--profile-trace",
        default="",
        help=(
            "Separate training trace used only to rank workflow-specific "
            "experts for prewarming."
        ),
    )
    parser.add_argument(
        "--prewarm-experts-per-layer",
        type=int,
        default=0,
        help="Top training-derived experts to make resident at each trace start.",
    )
    parser.add_argument(
        "--prewarm-from-prefill",
        type=int,
        default=0,
        help=(
            "Top experts observed in each evaluation trace's earlier prefill "
            "phase to make resident before its first decode token."
        ),
    )
    parser.add_argument(
        "--prewarm-admission",
        choices=("physical-only", "cache"),
        default="physical-only",
        help=(
            "Whether prewarm only establishes OS residency or also mutates "
            "the bounded logical cache."
        ),
    )
    parser.add_argument("--token-offset", type=int, default=0)
    parser.add_argument("--max-tokens", type=int, default=0)
    parser.add_argument(
        "--cold-start",
        action="store_true",
        help="Advise the OS to discard all clean mapped pages before timing.",
    )
    parser.add_argument("--output", default="")
    return parser.parse_args()


def load_trace(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    records = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if not records or records[0].get("type") != "metadata":
        raise ValueError("Trace must begin with a metadata record")
    metadata = records[0]
    if metadata.get("schema") != TRACE_SCHEMA or metadata.get("version") != 1:
        raise ValueError("Unsupported expert trace schema")
    tokens = records[1:]
    if any(record.get("type") != "token" for record in tokens):
        raise ValueError("Trace contains an unsupported record type")
    return metadata, tokens


def load_layout(path: Path) -> tuple[dict[str, Any], dict[tuple[int, int], list[ByteRange]]]:
    layout = json.loads(path.read_text(encoding="utf-8"))
    if layout.get("schema") != LAYOUT_SCHEMA or layout.get("version") != 1:
        raise ValueError("Unsupported expert layout schema")
    ranges: dict[tuple[int, int], list[ByteRange]] = {}
    for layer in layout["layers"]:
        layer_id = int(layer["layer"])
        for expert in layer["experts"]:
            key = (layer_id, int(expert["expert"]))
            ranges[key] = [
                ByteRange(
                    file_id=item["file_id"],
                    offset=int(item["offset"]),
                    length=int(item["length"]),
                )
                for item in expert["ranges"]
            ]
    return layout, ranges


def build_workflow_profiles(
    path: Path,
    trace_metadata: dict[str, Any],
    experts_per_layer: int,
) -> dict[str, list[list[int]]]:
    profile_metadata, profile_tokens = load_trace(path)
    for key in ("model", "layers", "experts_per_layer"):
        if profile_metadata.get(key) != trace_metadata.get(key):
            raise ValueError(
                f"Profile trace {key} does not match evaluation trace"
            )
    frequencies: dict[str, list[Counter[int]]] = defaultdict(
        lambda: [
            Counter() for _ in range(int(trace_metadata["layers"]))
        ]
    )
    for record in profile_tokens:
        if record.get("phase") != "decode":
            continue
        workflow = str(record.get("workflow") or "unknown")
        for layer, selected in enumerate(record["experts"]):
            frequencies[workflow][layer].update(map(int, selected))
    return {
        workflow: [
            [
                expert
                for expert, _count in sorted(
                    counts.items(),
                    key=lambda item: (-item[1], item[0]),
                )[:experts_per_layer]
            ]
            for counts in layers
        ]
        for workflow, layers in frequencies.items()
    }


def build_prefill_profiles(
    tokens: list[dict[str, Any]],
    layers: int,
    experts_per_layer: int,
) -> dict[str, list[list[int]]]:
    frequencies: dict[str, list[Counter[int]]] = defaultdict(
        lambda: [Counter() for _ in range(layers)]
    )
    for record in tokens:
        if record.get("phase") != "prefill":
            continue
        trace_id = str(record.get("trace_id") or "unknown")
        for layer, selected in enumerate(record["experts"]):
            frequencies[trace_id][layer].update(map(int, selected))
    return {
        trace_id: [
            [
                expert
                for expert, _count in sorted(
                    counts.items(),
                    key=lambda item: (-item[1], item[0]),
                )[:experts_per_layer]
            ]
            for counts in layer_counts
        ]
        for trace_id, layer_counts in frequencies.items()
    }


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(quantile * len(ordered)) - 1))
    return ordered[index]


def new_stratum() -> dict[str, Any]:
    return {
        "token_latencies": [],
        "cold_bytes": [],
        "logical_miss_bytes": [],
        "hits": 0,
        "misses": 0,
    }


def summarize_stratum(bucket: dict[str, Any]) -> dict[str, Any]:
    token_latencies = bucket["token_latencies"]
    cold_bytes = bucket["cold_bytes"]
    logical_miss_bytes = bucket["logical_miss_bytes"]
    hits = int(bucket["hits"])
    misses = int(bucket["misses"])
    accesses = hits + misses
    return {
        "token_count": len(token_latencies),
        "expert_accesses": accesses,
        "hits": hits,
        "misses": misses,
        "hit_rate": hits / accesses if accesses else 0.0,
        "access_latency_ms": {
            "mean": (
                statistics.fmean(token_latencies) if token_latencies else 0.0
            ),
            "p95": percentile(token_latencies, 0.95),
            "max": max(token_latencies, default=0.0),
        },
        "cold_bytes_per_token": {
            "mean": statistics.fmean(cold_bytes) if cold_bytes else 0.0,
            "p95": percentile(cold_bytes, 0.95),
            "max": max(cold_bytes, default=0),
        },
        "logical_miss_bytes_per_token": {
            "mean": (
                statistics.fmean(logical_miss_bytes)
                if logical_miss_bytes
                else 0.0
            ),
            "p95": percentile(logical_miss_bytes, 0.95),
            "max": max(logical_miss_bytes, default=0),
        },
    }


def normalized_max_rss_bytes() -> int:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys_platform_is_darwin() else value * 1024)


def sys_platform_is_darwin() -> bool:
    return os.uname().sysname == "Darwin"


def release_owned_pages(
    mapped: MappedFiles,
    key: tuple[int, int],
    ranges: dict[tuple[int, int], list[ByteRange]],
) -> None:
    for candidate in ranges[key]:
        mapped.release_owned_pages(candidate)


def make_policy(args: argparse.Namespace):
    if args.mode == "natural":
        return NaturalPolicy()
    if args.mode == "disabled":
        return DisabledPolicy()
    if args.slots_per_layer <= 0:
        raise ValueError("--slots-per-layer must be positive")
    capacity = args.slots_per_layer
    if args.policy == "lru":
        return LayeredPolicy(lambda: LruPolicy(capacity, args.admit_after))
    return LayeredPolicy(lambda: SlruPolicy(capacity, args.admit_after))


def token_keys(record: dict[str, Any]) -> list[tuple[int, int]]:
    result: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    for layer, experts in enumerate(record["experts"]):
        for expert in experts:
            key = (layer, int(expert))
            if key not in seen:
                result.append(key)
                seen.add(key)
    return result


def prewarm_workflow(
    mapped: MappedFiles,
    policy: Any,
    profile: list[list[int]],
    ranges: dict[tuple[int, int], list[ByteRange]],
    admit_to_policy: bool,
) -> tuple[dict[str, Any], list[tuple[int, int]]]:
    started = time.perf_counter()
    cold_bytes = 0
    logical_misses = 0
    evictions = 0
    experts = 0
    warmed_keys: list[tuple[int, int]] = []
    for layer, selected in enumerate(profile):
        # Least-frequent entries go first so the highest-ranked experts remain
        # most recent if the profile is wider than the protected segment.
        for expert in reversed(selected):
            key = (layer, expert)
            warmed_keys.append(key)
            experts += 1
            physically_cold = False
            for item in ranges[key]:
                resident, total_pages = mapped.residency(item)
                cold_bytes += min(
                    item.length,
                    max(0, total_pages - resident) * mapped.page_size,
                )
                physically_cold = physically_cold or resident < total_pages
            if admit_to_policy:
                first = policy.access(key)
                if not first.hit:
                    logical_misses += 1
                # The second access promotes SLRU probation entries. For LRU
                # this is a harmless recency touch.
                second = policy.access(key)
                for decision in (first, second):
                    for evicted in decision.evicted:
                        evictions += 1
                        release_owned_pages(mapped, evicted, ranges)
            if physically_cold:
                for item in ranges[key]:
                    mapped.prefetch(item)
            for item in ranges[key]:
                mapped.touch(item)
    return (
        {
            "experts": experts,
            "logical_misses": logical_misses,
            "evictions": evictions,
            "physical_cold_bytes": cold_bytes,
            "elapsed_ms": (time.perf_counter() - started) * 1000,
        },
        warmed_keys,
    )


def replay(args: argparse.Namespace) -> dict[str, Any]:
    trace_metadata, all_tokens = load_trace(Path(args.trace))
    tokens = all_tokens
    layout, ranges = load_layout(Path(args.layout))
    if trace_metadata["layers"] != layout["layer_count"]:
        raise ValueError("Trace and layout layer counts differ")
    if trace_metadata["experts_per_layer"] != layout["experts_per_layer"]:
        raise ValueError("Trace and layout expert counts differ")
    if args.phase != "all":
        tokens = [
            record for record in tokens if record.get("phase") == args.phase
        ]
    if args.trace_id:
        selected_trace_ids = set(args.trace_id)
        tokens = [
            record
            for record in tokens
            if record.get("trace_id") in selected_trace_ids
        ]
    if args.workflow:
        selected_workflows = set(args.workflow)
        tokens = [
            record
            for record in tokens
            if record.get("workflow") in selected_workflows
        ]
    if args.token_offset < 0:
        raise ValueError("--token-offset must be non-negative")
    if args.token_offset:
        tokens = tokens[args.token_offset :]
    if args.max_tokens > 0:
        tokens = tokens[: args.max_tokens]
    policy = make_policy(args)
    mapped = MappedFiles(layout["files"])
    workflow_profiles: dict[str, list[list[int]]] = {}
    prefill_profiles: dict[str, list[list[int]]] = {}
    if args.prewarm_from_prefill < 0:
        raise ValueError("--prewarm-from-prefill must be non-negative")
    if args.prewarm_from_prefill:
        if args.mode != "working-set":
            raise ValueError(
                "--prewarm-from-prefill requires --mode working-set"
            )
        prefill_profiles = build_prefill_profiles(
            all_tokens,
            int(trace_metadata["layers"]),
            args.prewarm_from_prefill,
        )
    if args.profile_trace:
        if args.mode != "working-set":
            raise ValueError("--profile-trace requires --mode working-set")
        if args.prewarm_experts_per_layer <= 0:
            raise ValueError(
                "--profile-trace requires positive "
                "--prewarm-experts-per-layer"
            )
        workflow_profiles = build_workflow_profiles(
            Path(args.profile_trace),
            trace_metadata,
            args.prewarm_experts_per_layer,
        )
    elif args.prewarm_experts_per_layer:
        raise ValueError(
            "--prewarm-experts-per-layer requires --profile-trace"
        )
    if workflow_profiles and prefill_profiles:
        raise ValueError(
            "Choose either training-derived workflow prewarm or "
            "evaluation-prefill prewarm, not both"
        )
    usage_before = resource.getrusage(resource.RUSAGE_SELF)
    token_latencies: list[float] = []
    token_cold_bytes: list[int] = []
    token_logical_miss_bytes: list[int] = []
    hits = 0
    misses = 0
    admitted = 0
    evictions = 0
    fully_resident_accesses = 0
    partially_resident_accesses = 0
    unresident_accesses = 0
    resident_pages_before = 0
    total_pages_checked = 0
    by_trace: dict[str, dict[str, Any]] = defaultdict(new_stratum)
    by_workflow: dict[str, dict[str, Any]] = defaultdict(new_stratum)
    trace_boundaries: list[dict[str, Any]] = []
    previous_trace_id: str | None = None
    prewarm_trace_starts = 0
    profiled_trace_starts = 0
    prewarm_elapsed_ms = 0.0
    prewarm_physical_cold_bytes = 0
    prewarm_logical_misses = 0
    prewarm_evictions = 0
    if args.cold_start:
        mapped.release_all()
    started = time.perf_counter()

    try:
        for record in tokens:
            trace_id = str(record.get("trace_id") or "unknown")
            workflow = str(record.get("workflow") or "unknown")
            is_trace_boundary = trace_id != previous_trace_id
            prewarm_result: dict[str, Any] | None = None
            prewarm_keys: list[tuple[int, int]] = []
            if is_trace_boundary:
                prewarm_trace_starts += 1
                profile = (
                    prefill_profiles.get(trace_id)
                    or workflow_profiles.get(workflow)
                )
                if profile is not None:
                    profiled_trace_starts += 1
                    prewarm_result, prewarm_keys = prewarm_workflow(
                        mapped,
                        policy,
                        profile,
                        ranges,
                        args.prewarm_admission == "cache",
                    )
                    prewarm_elapsed_ms += prewarm_result["elapsed_ms"]
                    prewarm_physical_cold_bytes += prewarm_result[
                        "physical_cold_bytes"
                    ]
                    prewarm_logical_misses += prewarm_result[
                        "logical_misses"
                    ]
                    prewarm_evictions += prewarm_result["evictions"]
            token_started = time.perf_counter()
            cold_bytes = 0
            logical_miss_bytes = 0
            token_hits = 0
            token_misses = 0
            transient: list[tuple[int, int]] = []
            for key in token_keys(record):
                if key not in ranges:
                    raise ValueError(f"Trace selected missing layout expert {key}")
                resident_pages = 0
                checked_pages = 0
                for item in ranges[key]:
                    resident, total_pages = mapped.residency(item)
                    resident_pages += resident
                    checked_pages += total_pages
                    cold_bytes += min(
                        item.length,
                        max(0, total_pages - resident) * mapped.page_size,
                    )
                resident_pages_before += resident_pages
                total_pages_checked += checked_pages
                if checked_pages == 0:
                    pass
                elif resident_pages == checked_pages:
                    fully_resident_accesses += 1
                elif resident_pages > 0:
                    partially_resident_accesses += 1
                else:
                    unresident_accesses += 1
                decision = policy.access(key)
                if decision.hit:
                    hits += 1
                    token_hits += 1
                else:
                    misses += 1
                    token_misses += 1
                    logical_miss_bytes += sum(
                        item.length for item in ranges[key]
                    )
                if (
                    args.mode == "working-set"
                    and resident_pages < checked_pages
                ):
                    for item in ranges[key]:
                        mapped.prefetch(item)
                if decision.admitted and not decision.hit:
                    admitted += 1
                if not decision.admitted:
                    transient.append(key)
                for item in ranges[key]:
                    mapped.touch(item)
                for evicted in decision.evicted:
                    evictions += 1
                    release_owned_pages(mapped, evicted, ranges)
            if args.mode != "natural":
                for key in transient:
                    release_owned_pages(mapped, key, ranges)
            token_latency = (time.perf_counter() - token_started) * 1000
            if prewarm_keys and args.prewarm_admission == "physical-only":
                cleanup_started = time.perf_counter()
                resident_keys = policy.resident_keys()
                cleanup_releases = 0
                for key in prewarm_keys:
                    if key not in resident_keys:
                        release_owned_pages(mapped, key, ranges)
                        cleanup_releases += 1
                if prewarm_result is not None:
                    prewarm_result["cleanup_releases"] = cleanup_releases
                    prewarm_result["cleanup_elapsed_ms"] = (
                        time.perf_counter() - cleanup_started
                    ) * 1000
            token_latencies.append(token_latency)
            token_cold_bytes.append(cold_bytes)
            token_logical_miss_bytes.append(logical_miss_bytes)
            for bucket in (by_trace[trace_id], by_workflow[workflow]):
                bucket["token_latencies"].append(token_latency)
                bucket["cold_bytes"].append(cold_bytes)
                bucket["logical_miss_bytes"].append(logical_miss_bytes)
                bucket["hits"] += token_hits
                bucket["misses"] += token_misses
            if is_trace_boundary:
                trace_boundaries.append(
                    {
                        "trace_id": trace_id,
                        "workflow": workflow,
                        "token_index": record.get("token_index"),
                        "first_token_access_latency_ms": token_latency,
                        "first_token_physical_cold_bytes": cold_bytes,
                        "first_token_logical_miss_bytes": logical_miss_bytes,
                        "prewarm": prewarm_result,
                    }
                )
                previous_trace_id = trace_id
    finally:
        elapsed = time.perf_counter() - started
        usage_after = resource.getrusage(resource.RUSAGE_SELF)
        mapped.close()

    total = hits + misses
    report = {
        "schema": REPORT_SCHEMA,
        "version": REPORT_VERSION,
        "mode": args.mode,
        "policy": args.policy if args.mode == "working-set" else None,
        "model": trace_metadata["model"],
        "runtime_revision": layout["source_revision"],
        "trace_phase": args.phase,
        "selected_trace_ids": args.trace_id,
        "selected_workflows": args.workflow,
        "profile_trace": (
            Path(args.profile_trace).name if args.profile_trace else None
        ),
        "prewarm_experts_per_layer": args.prewarm_experts_per_layer,
        "prewarm_from_prefill": args.prewarm_from_prefill,
        "prewarm_admission": args.prewarm_admission,
        "token_offset": args.token_offset,
        "token_count": len(tokens),
        "expert_accesses": total,
        "hits": hits,
        "misses": misses,
        "hit_rate": hits / total if total else 0.0,
        "admissions": admitted,
        "evictions": evictions,
        "slots_per_layer": args.slots_per_layer,
        "admit_after": args.admit_after,
        "cold_start": args.cold_start,
        "elapsed_seconds": elapsed,
        "tokens_per_second": len(tokens) / elapsed if elapsed else 0.0,
        "access_latency_ms": {
            "mean": statistics.fmean(token_latencies) if token_latencies else 0.0,
            "p50": percentile(token_latencies, 0.50),
            "p95": percentile(token_latencies, 0.95),
            "p99": percentile(token_latencies, 0.99),
            "max": max(token_latencies, default=0.0),
        },
        "cold_bytes_per_token": {
            "mean": statistics.fmean(token_cold_bytes) if token_cold_bytes else 0.0,
            "p50": percentile(token_cold_bytes, 0.50),
            "p95": percentile(token_cold_bytes, 0.95),
            "p99": percentile(token_cold_bytes, 0.99),
            "max": max(token_cold_bytes, default=0),
        },
        "logical_miss_bytes_per_token": {
            "mean": (
                statistics.fmean(token_logical_miss_bytes)
                if token_logical_miss_bytes
                else 0.0
            ),
            "p50": percentile(token_logical_miss_bytes, 0.50),
            "p95": percentile(token_logical_miss_bytes, 0.95),
            "p99": percentile(token_logical_miss_bytes, 0.99),
            "max": max(token_logical_miss_bytes, default=0),
        },
        "page_faults": {
            "major": usage_after.ru_majflt - usage_before.ru_majflt,
            "minor": usage_after.ru_minflt - usage_before.ru_minflt,
        },
        "physical_residency_before_access": {
            "fully_resident_accesses": fully_resident_accesses,
            "partially_resident_accesses": partially_resident_accesses,
            "unresident_accesses": unresident_accesses,
            "resident_pages": resident_pages_before,
            "pages_checked": total_pages_checked,
            "resident_page_rate": (
                resident_pages_before / total_pages_checked
                if total_pages_checked
                else None
            ),
            "mincore_calls": mapped.mincore_calls,
        },
        "max_rss_bytes": normalized_max_rss_bytes(),
        "madvise": {
            "willneed_calls": mapped.madvise_willneed,
            "dontneed_calls": mapped.madvise_dontneed,
        },
        "strata": {
            "by_trace": {
                key: summarize_stratum(value)
                for key, value in sorted(by_trace.items())
            },
            "by_workflow": {
                key: summarize_stratum(value)
                for key, value in sorted(by_workflow.items())
            },
            "trace_boundaries": trace_boundaries,
        },
        "workflow_prewarm": {
            "enabled": bool(workflow_profiles or prefill_profiles),
            "source": (
                "evaluation-prefill"
                if prefill_profiles
                else "training-workflow"
                if workflow_profiles
                else None
            ),
            "admission": args.prewarm_admission,
            "trace_starts": prewarm_trace_starts,
            "profiled_trace_starts": profiled_trace_starts,
            "elapsed_ms": prewarm_elapsed_ms,
            "physical_cold_bytes": prewarm_physical_cold_bytes,
            "logical_misses": prewarm_logical_misses,
            "evictions": prewarm_evictions,
        },
        "checksum": mapped.checksum,
    }
    return report


def main() -> int:
    args = parse_args()
    report = replay(args)
    encoded = json.dumps(report, indent=2) + "\n"
    if args.output:
        output = Path(args.output).expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
