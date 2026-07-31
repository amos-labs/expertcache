#import <Foundation/Foundation.h>

#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml-metal.h"
#include "ggml.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <fcntl.h>
#include <iostream>
#include <numeric>
#include <string>
#include <unistd.h>
#include <vector>

namespace {

struct WeightRange {
    off_t offset = 0;
    size_t length = 0;
    std::string tensor;
};

struct Expert {
    int id = -1;
    std::vector<WeightRange> ranges;
};

struct Options {
    std::string model;
    std::string layout;
    std::string tensor = "gate";
    std::string output;
    int layer = 0;
    int slots = 4;
    int tokens = 1;
};

struct RunResult {
    std::string backend;
    std::vector<float> output;
    double elapsed_ms = 0;
};

std::string option(
    const std::vector<std::string> & args,
    const std::string & name
) {
    for (size_t index = 0; index + 1 < args.size(); ++index) {
        if (args[index] == name) return args[index + 1];
    }
    return "";
}

std::string required(
    const std::vector<std::string> & args,
    const std::string & name
) {
    const std::string value = option(args, name);
    if (!value.empty()) return value;
    std::cerr << "Missing required option " << name << "\n";
    std::exit(2);
}

int integer_option(
    const std::vector<std::string> & args,
    const std::string & name,
    int fallback,
    int minimum,
    int maximum
) {
    const std::string value = option(args, name);
    if (value.empty()) return fallback;
    const long parsed = std::strtol(value.c_str(), nullptr, 10);
    if (parsed < minimum || parsed > maximum) {
        std::cerr << name << " must be between " << minimum << " and "
                  << maximum << "\n";
        std::exit(2);
    }
    return static_cast<int>(parsed);
}

Options parse_options(int argc, const char * argv[]) {
    const std::vector<std::string> args(argv + 1, argv + argc);
    Options result;
    result.model = required(args, "--model");
    result.layout = required(args, "--layout");
    result.output = option(args, "--output");
    const std::string tensor = option(args, "--tensor");
    if (!tensor.empty()) result.tensor = tensor;
    if (
        result.tensor != "down" &&
        result.tensor != "gate" &&
        result.tensor != "up"
    ) {
        std::cerr << "--tensor must be down, gate, or up\n";
        std::exit(2);
    }
    result.layer = integer_option(args, "--layer", 0, 0, 255);
    result.slots = integer_option(args, "--slots", 4, 4, 128);
    result.tokens = integer_option(args, "--tokens", 1, 1, 32);
    return result;
}

id parse_json(NSData * data, const std::string & label) {
    NSError * error = nil;
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if (!value || error) {
        std::cerr << "Could not parse " << label << ": "
                  << [[error localizedDescription] UTF8String] << "\n";
        std::exit(1);
    }
    return value;
}

NSDictionary * read_json_object(const std::string & path) {
    NSData * data = [NSData dataWithContentsOfFile:
        [NSString stringWithUTF8String:path.c_str()]];
    if (!data) {
        std::cerr << "Could not read JSON file " << path << "\n";
        std::exit(1);
    }
    id value = parse_json(data, path);
    if (![value isKindOfClass:[NSDictionary class]]) {
        std::cerr << path << " is not a JSON object\n";
        std::exit(1);
    }
    return (NSDictionary *)value;
}

std::vector<Expert> load_layout(
    const std::string & path,
    int layer
) {
    NSDictionary * root = read_json_object(path);
    NSArray * layers = root[@"layers"];
    if (
        ![layers isKindOfClass:[NSArray class]] ||
        layer >= static_cast<int>([layers count])
    ) {
        std::cerr << "Layout does not contain layer " << layer << "\n";
        std::exit(1);
    }
    NSArray * values = layers[layer][@"experts"];
    std::vector<Expert> experts([values count]);
    for (NSDictionary * value in values) {
        Expert expert;
        expert.id = [value[@"expert"] intValue];
        for (NSDictionary * range in value[@"ranges"]) {
            expert.ranges.push_back({
                static_cast<off_t>([range[@"offset"] longLongValue]),
                static_cast<size_t>([range[@"length"] unsignedLongLongValue]),
                [range[@"tensor"] UTF8String]
            });
        }
        if (
            expert.id < 0 ||
            expert.id >= static_cast<int>(experts.size()) ||
            expert.ranges.size() != 3
        ) {
            std::cerr << "Invalid expert layout entry at layer " << layer << "\n";
            std::exit(1);
        }
        experts[expert.id] = std::move(expert);
    }
    return experts;
}

const WeightRange & select_range(
    const Expert & expert,
    const std::string & tensor
) {
    const std::string needle = "ffn_" + tensor + "_exps.weight";
    const auto selected = std::find_if(
        expert.ranges.begin(),
        expert.ranges.end(),
        [&](const WeightRange & range) {
            return range.tensor.find(needle) != std::string::npos;
        }
    );
    if (selected == expert.ranges.end()) {
        std::cerr << "Expert " << expert.id << " has no " << tensor
                  << " tensor range\n";
        std::exit(1);
    }
    return *selected;
}

void read_exact(
    int file,
    off_t offset,
    uint8_t * destination,
    size_t length
) {
    size_t written = 0;
    while (written < length) {
        const ssize_t count = pread(
            file,
            destination + written,
            length - written,
            offset + static_cast<off_t>(written)
        );
        if (count <= 0) {
            perror("pread model tensor");
            std::exit(1);
        }
        written += static_cast<size_t>(count);
    }
}

std::vector<uint8_t> load_weights(
    const Options & options,
    const std::vector<Expert> & experts,
    size_t & bytes_per_slot
) {
    const WeightRange & first = select_range(experts.front(), options.tensor);
    bytes_per_slot = first.length;
    const int file = open(options.model.c_str(), O_RDONLY);
    if (file < 0) {
        perror("open model");
        std::exit(1);
    }
    std::vector<uint8_t> weights(
        static_cast<size_t>(options.slots) * bytes_per_slot
    );
    for (int slot = 0; slot < options.slots; ++slot) {
        const WeightRange & range = select_range(experts[slot], options.tensor);
        if (range.length != bytes_per_slot) {
            std::cerr << "Expert tensor byte length changed at slot "
                      << slot << "\n";
            close(file);
            std::exit(1);
        }
        read_exact(
            file,
            range.offset,
            weights.data() + static_cast<size_t>(slot) * bytes_per_slot,
            bytes_per_slot
        );
    }
    close(file);
    return weights;
}

RunResult run_graph(
    ggml_backend_t backend,
    const std::vector<uint8_t> & weights,
    int slots,
    int tokens
) {
    constexpr int64_t k = 2880;
    constexpr int64_t m = 2880;
    constexpr int n_used = 4;
    const size_t graph_nodes = 32;
    const ggml_init_params params = {
        /* .mem_size = */
            ggml_tensor_overhead() * 16 +
            ggml_graph_overhead_custom(graph_nodes, false),
        /* .mem_buffer = */ nullptr,
        /* .no_alloc = */ true,
    };
    ggml_context * context = ggml_init(params);
    if (!context) {
        std::cerr << "Could not initialize ggml context\n";
        std::exit(1);
    }

    ggml_tensor * slot_weights = ggml_new_tensor_3d(
        context,
        GGML_TYPE_MXFP4,
        k,
        m,
        slots
    );
    ggml_set_name(slot_weights, "expert_slot_weights");
    ggml_tensor * all_ids = ggml_new_tensor_2d(
        context,
        GGML_TYPE_I32,
        slots,
        tokens
    );
    ggml_set_name(all_ids, "all_slot_ids");
    ggml_tensor * compact_ids = ggml_view_2d(
        context,
        all_ids,
        n_used,
        tokens,
        all_ids->nb[1],
        0
    );
    ggml_set_name(compact_ids, "compact_slot_ids");
    ggml_tensor * input = ggml_new_tensor_3d(
        context,
        GGML_TYPE_F32,
        k,
        n_used,
        tokens
    );
    ggml_set_name(input, "expert_input");
    ggml_tensor * output = ggml_mul_mat_id(
        context,
        slot_weights,
        input,
        compact_ids
    );
    ggml_set_name(output, "slot_output");

    ggml_backend_buffer_t buffer =
        ggml_backend_alloc_ctx_tensors(context, backend);
    if (!buffer) {
        std::cerr << "Could not allocate graph tensors on "
                  << ggml_backend_name(backend) << "\n";
        ggml_free(context);
        std::exit(1);
    }
    ggml_backend_buffer_set_usage(
        buffer,
        GGML_BACKEND_BUFFER_USAGE_WEIGHTS
    );
    if (weights.size() != ggml_nbytes(slot_weights)) {
        std::cerr << "Loaded weights contain " << weights.size()
                  << " bytes; ggml slot tensor requires "
                  << ggml_nbytes(slot_weights) << "\n";
        ggml_backend_buffer_free(buffer);
        ggml_free(context);
        std::exit(1);
    }
    ggml_backend_tensor_set(
        slot_weights,
        weights.data(),
        0,
        weights.size()
    );

    std::vector<int32_t> ids(
        static_cast<size_t>(slots) * static_cast<size_t>(tokens),
        0
    );
    for (int token = 0; token < tokens; ++token) {
        for (int lane = 0; lane < n_used; ++lane) {
            ids[static_cast<size_t>(token) * slots + lane] =
                (token + lane) % slots;
        }
    }
    ggml_backend_tensor_set(
        all_ids,
        ids.data(),
        0,
        ids.size() * sizeof(ids.front())
    );

    std::vector<float> input_values(
        static_cast<size_t>(k) * n_used * tokens
    );
    for (size_t index = 0; index < input_values.size(); ++index) {
        input_values[index] =
            std::sin(static_cast<float>(index % k) * 0.013f) * 0.25f +
            std::cos(static_cast<float>(index % 97) * 0.031f) * 0.05f;
    }
    ggml_backend_tensor_set(
        input,
        input_values.data(),
        0,
        input_values.size() * sizeof(input_values.front())
    );

    ggml_cgraph * graph = ggml_new_graph_custom(
        context,
        graph_nodes,
        false
    );
    ggml_build_forward_expand(graph, output);
    ggml_backend_synchronize(backend);
    const auto started = std::chrono::steady_clock::now();
    const ggml_status status = ggml_backend_graph_compute(backend, graph);
    ggml_backend_synchronize(backend);
    const auto stopped = std::chrono::steady_clock::now();
    if (status != GGML_STATUS_SUCCESS) {
        std::cerr << "MUL_MAT_ID failed on " << ggml_backend_name(backend)
                  << ": " << ggml_status_to_string(status) << "\n";
        ggml_backend_buffer_free(buffer);
        ggml_free(context);
        std::exit(1);
    }

    RunResult result;
    result.backend = ggml_backend_name(backend);
    result.elapsed_ms = std::chrono::duration<double, std::milli>(
        stopped - started
    ).count();
    result.output.resize(ggml_nelements(output));
    ggml_backend_tensor_get(
        output,
        result.output.data(),
        0,
        result.output.size() * sizeof(result.output.front())
    );
    ggml_backend_buffer_free(buffer);
    ggml_free(context);
    return result;
}

NSDictionary * build_report(
    const Options & options,
    size_t bytes_per_slot,
    const RunResult & cpu,
    const RunResult & metal
) {
    if (cpu.output.size() != metal.output.size()) {
        std::cerr << "Backend output sizes differ\n";
        std::exit(1);
    }
    double squared_error = 0;
    double squared_reference = 0;
    double max_absolute_error = 0;
    bool finite = true;
    for (size_t index = 0; index < cpu.output.size(); ++index) {
        const double expected = cpu.output[index];
        const double actual = metal.output[index];
        const double difference = actual - expected;
        squared_error += difference * difference;
        squared_reference += expected * expected;
        max_absolute_error = std::max(
            max_absolute_error,
            std::abs(difference)
        );
        finite = finite && std::isfinite(expected) && std::isfinite(actual);
    }
    const double nmse = squared_reference > 0
        ? squared_error / squared_reference
        : squared_error;
    const bool equivalent = finite && nmse <= 5e-4;
    return @{
        @"schema": @"amos.expert-mxfp4-slot-equivalence",
        @"version": @1,
        @"model": [NSString stringWithUTF8String:options.model.c_str()],
        @"layer": @(options.layer),
        @"tensor": [NSString stringWithUTF8String:options.tensor.c_str()],
        @"slot_count": @(options.slots),
        @"selected_per_token": @4,
        @"tokens": @(options.tokens),
        @"bytes_per_slot": @(bytes_per_slot),
        @"slot_pool_bytes": @(bytes_per_slot * options.slots),
        @"operation": @"GGML_OP_MUL_MAT_ID",
        @"type": @"MXFP4",
        @"cpu_backend":
            [NSString stringWithUTF8String:cpu.backend.c_str()],
        @"metal_backend":
            [NSString stringWithUTF8String:metal.backend.c_str()],
        @"cpu_elapsed_ms": @(cpu.elapsed_ms),
        @"metal_elapsed_ms": @(metal.elapsed_ms),
        @"output_elements": @(cpu.output.size()),
        @"finite": @(finite),
        @"nmse": @(nmse),
        @"max_absolute_error": @(max_absolute_error),
        @"equivalence_threshold_nmse": @5e-4,
        @"equivalent": @(equivalent),
        @"gate": equivalent ? @"PASS" : @"FAIL",
        @"scope": @[
            @"real GPT-OSS 120B expert bytes",
            @"bounded fixed-address ggml slot tensor",
            @"compact slot IDs",
            @"native MXFP4 MUL_MAT_ID",
            @"Metal output compared with CPU reference"
        ],
        @"not_yet_proven": @[
            @"file-backed Metal miss fills feeding the ggml slot tensor",
            @"complete gate/up/down MoE layer",
            @"GPU-resident router and cache resolution",
            @"end-to-end token generation"
        ]
    };
}

} // namespace

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        const Options options = parse_options(argc, argv);
        const std::vector<Expert> experts =
            load_layout(options.layout, options.layer);
        if (options.slots > static_cast<int>(experts.size())) {
            std::cerr << "Slot count exceeds expert count\n";
            return 2;
        }
        size_t bytes_per_slot = 0;
        const std::vector<uint8_t> weights =
            load_weights(options, experts, bytes_per_slot);

        ggml_backend_t cpu = ggml_backend_cpu_init();
        ggml_backend_t metal = ggml_backend_metal_init();
        if (!cpu || !metal) {
            std::cerr << "Could not initialize CPU and Metal backends\n";
            if (cpu) ggml_backend_free(cpu);
            if (metal) ggml_backend_free(metal);
            return 1;
        }
        const RunResult cpu_result = run_graph(
            cpu,
            weights,
            options.slots,
            options.tokens
        );
        const RunResult metal_result = run_graph(
            metal,
            weights,
            options.slots,
            options.tokens
        );
        NSDictionary * report = build_report(
            options,
            bytes_per_slot,
            cpu_result,
            metal_result
        );
        ggml_backend_free(cpu);
        ggml_backend_free(metal);

        NSError * error = nil;
        NSData * serialized = [NSJSONSerialization
            dataWithJSONObject:report
            options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys
            error:&error
        ];
        if (!serialized || error) {
            std::cerr << "Could not serialize report: "
                      << [[error localizedDescription] UTF8String] << "\n";
            return 1;
        }
        if (!options.output.empty()) {
            if (![serialized writeToFile:
                [NSString stringWithUTF8String:options.output.c_str()]
                atomically:YES
            ]) {
                std::cerr << "Could not write " << options.output << "\n";
                return 1;
            }
        }
        std::cout.write(
            static_cast<const char *>([serialized bytes]),
            [serialized length]
        );
        std::cout << "\n";
        return [report[@"equivalent"] boolValue] ? 0 : 1;
    }
}
