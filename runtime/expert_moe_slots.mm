#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-backend-impl.h"
#include "ggml-cpu.h"
#include "ggml-metal-device.h"
#include "ggml-metal.h"
#include "ggml.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <fcntl.h>
#include <iostream>
#include <sstream>
#include <string>
#include <sys/mman.h>
#include <unistd.h>
#include <vector>

namespace {

constexpr int64_t EMBEDDING = 2880;
constexpr int64_t EXPERT_FF = 2880;
constexpr int EXPERTS_PER_LAYER = 128;
constexpr int EXPERTS_USED = 4;

struct WeightRange {
    off_t offset = 0;
    size_t length = 0;
    std::string tensor;
};

struct Expert {
    int id = -1;
    std::vector<WeightRange> ranges;
};

struct ProjectionData {
    std::vector<uint8_t> weights;
    std::vector<float> biases;
    size_t weight_bytes_per_slot = 0;
};

struct Options {
    std::string model;
    std::string layout;
    std::string output;
    std::vector<int> expert_ids = {45, 72, 5, 18};
    int layer = 0;
    int tokens = 1;
};

struct RunResult {
    std::string backend;
    std::vector<float> output;
    double elapsed_ms = 0;
    double weight_fill_ms = 0;
    int mapped_file_buffers = 0;
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

std::vector<int> parse_expert_ids(const std::string & value) {
    if (value.empty()) return {45, 72, 5, 18};
    std::vector<int> result;
    std::stringstream input(value);
    std::string item;
    while (std::getline(input, item, ',')) {
        const int id = std::stoi(item);
        if (id < 0 || id >= EXPERTS_PER_LAYER) {
            std::cerr << "Expert IDs must be between 0 and 127\n";
            std::exit(2);
        }
        result.push_back(id);
    }
    if (result.size() != EXPERTS_USED) {
        std::cerr << "--expert-ids requires exactly four comma-separated IDs\n";
        std::exit(2);
    }
    return result;
}

Options parse_options(int argc, const char * argv[]) {
    const std::vector<std::string> args(argv + 1, argv + argc);
    Options result;
    result.model = required(args, "--model");
    result.layout = required(args, "--layout");
    result.output = option(args, "--output");
    result.expert_ids = parse_expert_ids(option(args, "--expert-ids"));
    result.layer = integer_option(args, "--layer", 0, 0, 255);
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
    const std::string & projection
) {
    const std::string needle = "ffn_" + projection + "_exps.weight";
    const auto selected = std::find_if(
        expert.ranges.begin(),
        expert.ranges.end(),
        [&](const WeightRange & range) {
            return range.tensor.find(needle) != std::string::npos;
        }
    );
    if (selected == expert.ranges.end()) {
        std::cerr << "Expert " << expert.id << " has no " << projection
                  << " tensor range\n";
        std::exit(1);
    }
    return *selected;
}

void read_exact(
    int file,
    off_t offset,
    void * destination,
    size_t length
) {
    size_t written = 0;
    auto * bytes = static_cast<uint8_t *>(destination);
    while (written < length) {
        const ssize_t count = pread(
            file,
            bytes + written,
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

ProjectionData load_projection(
    int file,
    const std::vector<Expert> & experts,
    const std::vector<int> & expert_ids,
    const std::string & projection
) {
    const WeightRange & first = select_range(experts.front(), projection);
    const size_t weight_bytes = first.length;
    const size_t bias_bytes_per_expert =
        static_cast<size_t>(EXPERT_FF) * sizeof(float);
    const size_t all_bias_bytes =
        bias_bytes_per_expert * EXPERTS_PER_LAYER;
    const off_t bias_start =
        first.offset - static_cast<off_t>(all_bias_bytes);

    ProjectionData result;
    result.weight_bytes_per_slot = weight_bytes;
    result.weights.resize(weight_bytes * expert_ids.size());
    result.biases.resize(
        static_cast<size_t>(EXPERT_FF) * expert_ids.size()
    );
    for (size_t slot = 0; slot < expert_ids.size(); ++slot) {
        const int expert_id = expert_ids[slot];
        const WeightRange & weight =
            select_range(experts[expert_id], projection);
        if (weight.length != weight_bytes) {
            std::cerr << "Weight size changed for " << projection
                      << " expert " << expert_id << "\n";
            std::exit(1);
        }
        read_exact(
            file,
            weight.offset,
            result.weights.data() + slot * weight_bytes,
            weight_bytes
        );
        read_exact(
            file,
            bias_start +
                static_cast<off_t>(expert_id * bias_bytes_per_expert),
            result.biases.data() +
                slot * static_cast<size_t>(EXPERT_FF),
            bias_bytes_per_expert
        );
    }
    return result;
}

struct MappedProjection {
    id<MTLBuffer> buffer = nil;
    size_t data_offset = 0;
    size_t weight_bytes_per_expert = 0;
};

MappedProjection map_projection(
    id<MTLDevice> device,
    int file,
    const std::vector<Expert> & experts,
    const std::string & projection
) {
    const WeightRange & first =
        select_range(experts.front(), projection);
    const WeightRange & last =
        select_range(experts.back(), projection);
    const long page_size = sysconf(_SC_PAGESIZE);
    const off_t data_start = first.offset;
    const off_t data_end =
        last.offset + static_cast<off_t>(last.length);
    const off_t map_start =
        data_start - (data_start % static_cast<off_t>(page_size));
    const size_t data_offset =
        static_cast<size_t>(data_start - map_start);
    const size_t raw_length =
        static_cast<size_t>(data_end - map_start);
    const size_t map_length =
        (raw_length + page_size - 1) /
        static_cast<size_t>(page_size) *
        static_cast<size_t>(page_size);
    void * mapped = mmap(
        nullptr,
        map_length,
        PROT_READ | PROT_WRITE,
        MAP_PRIVATE,
        file,
        map_start
    );
    if (mapped == MAP_FAILED) {
        perror("mmap expert projection");
        std::exit(1);
    }
    id<MTLBuffer> buffer = [device
        newBufferWithBytesNoCopy:mapped
        length:map_length
        options:MTLResourceStorageModeShared
        deallocator:^(void * pointer, NSUInteger length) {
            munmap(pointer, length);
        }
    ];
    if (!buffer) {
        munmap(mapped, map_length);
        std::cerr << "Could not wrap mapped " << projection
                  << " tensor in a Metal buffer\n";
        std::exit(1);
    }
    return {
        buffer,
        data_offset,
        first.length
    };
}

struct MetalMappedWeights {
    MappedProjection gate;
    MappedProjection up;
    MappedProjection down;
};

MetalMappedWeights map_all_projections(
    id<MTLDevice> device,
    const std::string & model,
    const std::vector<Expert> & experts
) {
    const int file = open(model.c_str(), O_RDONLY);
    if (file < 0) {
        perror("open model for Metal mapping");
        std::exit(1);
    }
    MetalMappedWeights result = {
        map_projection(device, file, experts, "gate"),
        map_projection(device, file, experts, "up"),
        map_projection(device, file, experts, "down")
    };
    close(file);
    return result;
}

struct DestinationProjection {
    id<MTLBuffer> buffer = nil;
    size_t offset = 0;
};

DestinationProjection metal_destination(ggml_tensor * tensor) {
    if (!tensor->buffer || !tensor->buffer->context) {
        std::cerr << "ggml tensor has no Metal buffer\n";
        std::exit(1);
    }
    const ggml_metal_buffer_id buffer_id = ggml_metal_buffer_get_id(
        static_cast<ggml_metal_buffer_t>(tensor->buffer->context),
        tensor
    );
    if (!buffer_id.metal) {
        std::cerr << "Could not resolve ggml tensor's MTLBuffer\n";
        std::exit(1);
    }
    return {
        (__bridge id<MTLBuffer>)buffer_id.metal,
        buffer_id.offs
    };
}

double fill_mapped_weights(
    const MetalMappedWeights & sources,
    const std::vector<int> & expert_ids,
    ggml_tensor * gate_weights,
    ggml_tensor * up_weights,
    ggml_tensor * down_weights
) {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    id<MTLCommandQueue> queue = [device newCommandQueue];
    id<MTLCommandBuffer> command = [queue commandBuffer];
    id<MTLBlitCommandEncoder> blit = [command blitCommandEncoder];
    if (!device || !queue || !command || !blit) {
        std::cerr << "Could not create mapped-weight blit command\n";
        std::exit(1);
    }
    const DestinationProjection gate_destination =
        metal_destination(gate_weights);
    const DestinationProjection up_destination =
        metal_destination(up_weights);
    const DestinationProjection down_destination =
        metal_destination(down_weights);

    auto fill_projection = [&](
        const MappedProjection & source,
        const DestinationProjection & destination
    ) {
        for (size_t slot = 0; slot < expert_ids.size(); ++slot) {
            [blit copyFromBuffer:source.buffer
                  sourceOffset:
                    source.data_offset +
                    static_cast<size_t>(expert_ids[slot]) *
                        source.weight_bytes_per_expert
                      toBuffer:destination.buffer
             destinationOffset:
                    destination.offset +
                    slot * source.weight_bytes_per_expert
                         size:source.weight_bytes_per_expert];
        }
    };
    fill_projection(sources.gate, gate_destination);
    fill_projection(sources.up, up_destination);
    fill_projection(sources.down, down_destination);
    [blit endEncoding];

    const auto started = std::chrono::steady_clock::now();
    [command commit];
    [command waitUntilCompleted];
    const auto stopped = std::chrono::steady_clock::now();
    if ([command status] != MTLCommandBufferStatusCompleted) {
        std::cerr << "Mapped-weight Metal blit failed: "
                  << [[[command error] localizedDescription] UTF8String]
                  << "\n";
        std::exit(1);
    }
    return std::chrono::duration<double, std::milli>(
        stopped - started
    ).count();
}

void set_projection(
    ggml_tensor * weights,
    ggml_tensor * biases,
    const ProjectionData & data
) {
    if (
        data.weights.size() != ggml_nbytes(weights) ||
        data.biases.size() * sizeof(float) != ggml_nbytes(biases)
    ) {
        std::cerr << "Projection data does not match ggml tensor shape\n";
        std::exit(1);
    }
    ggml_backend_tensor_set(
        weights,
        data.weights.data(),
        0,
        data.weights.size()
    );
    ggml_backend_tensor_set(
        biases,
        data.biases.data(),
        0,
        data.biases.size() * sizeof(float)
    );
}

RunResult run_graph(
    ggml_backend_t backend,
    const ProjectionData & gate_data,
    const ProjectionData & up_data,
    const ProjectionData & down_data,
    int tokens,
    const MetalMappedWeights * mapped_weights,
    const std::vector<int> & expert_ids
) {
    const int slots = EXPERTS_USED;
    const size_t graph_nodes = 64;
    const ggml_init_params params = {
        /* .mem_size = */
            ggml_tensor_overhead() * 48 +
            ggml_graph_overhead_custom(graph_nodes, false),
        /* .mem_buffer = */ nullptr,
        /* .no_alloc = */ true,
    };
    ggml_context * context = ggml_init(params);
    if (!context) {
        std::cerr << "Could not initialize ggml context\n";
        std::exit(1);
    }

    auto make_weights = [&](const char * name) {
        ggml_tensor * value = ggml_new_tensor_3d(
            context,
            GGML_TYPE_MXFP4,
            EMBEDDING,
            EXPERT_FF,
            slots
        );
        ggml_set_name(value, name);
        return value;
    };
    auto make_biases = [&](const char * name) {
        ggml_tensor * value = ggml_new_tensor_2d(
            context,
            GGML_TYPE_F32,
            EXPERT_FF,
            slots
        );
        ggml_set_name(value, name);
        return value;
    };

    ggml_tensor * gate_weights = make_weights("gate_slot_weights");
    ggml_tensor * gate_biases = make_biases("gate_slot_biases");
    ggml_tensor * up_weights = make_weights("up_slot_weights");
    ggml_tensor * up_biases = make_biases("up_slot_biases");
    ggml_tensor * down_weights = make_weights("down_slot_weights");
    ggml_tensor * down_biases = make_biases("down_slot_biases");

    ggml_tensor * all_ids = ggml_new_tensor_2d(
        context,
        GGML_TYPE_I32,
        slots,
        tokens
    );
    ggml_set_name(all_ids, "all_compact_slot_ids");
    ggml_tensor * compact_ids = ggml_view_2d(
        context,
        all_ids,
        EXPERTS_USED,
        tokens,
        all_ids->nb[1],
        0
    );
    ggml_set_name(compact_ids, "compact_slot_ids");
    ggml_tensor * input = ggml_new_tensor_3d(
        context,
        GGML_TYPE_F32,
        EMBEDDING,
        1,
        tokens
    );
    ggml_set_name(input, "moe_input");
    ggml_tensor * route_weights = ggml_new_tensor_3d(
        context,
        GGML_TYPE_F32,
        1,
        EXPERTS_USED,
        tokens
    );
    ggml_set_name(route_weights, "route_weights");

    ggml_tensor * gate = ggml_mul_mat_id(
        context,
        gate_weights,
        input,
        compact_ids
    );
    gate = ggml_add_id(context, gate, gate_biases, compact_ids);
    ggml_tensor * up = ggml_mul_mat_id(
        context,
        up_weights,
        input,
        compact_ids
    );
    up = ggml_add_id(context, up, up_biases, compact_ids);
    ggml_tensor * activated = ggml_swiglu_oai(
        context,
        gate,
        up,
        1.702f,
        7.0f
    );
    ggml_tensor * experts = ggml_mul_mat_id(
        context,
        down_weights,
        activated,
        compact_ids
    );
    experts = ggml_add_id(
        context,
        experts,
        down_biases,
        compact_ids
    );
    experts = ggml_mul(context, experts, route_weights);

    ggml_tensor * output = ggml_view_2d(
        context,
        experts,
        EMBEDDING,
        tokens,
        experts->nb[2],
        0
    );
    for (int lane = 1; lane < EXPERTS_USED; ++lane) {
        ggml_tensor * selected = ggml_view_2d(
            context,
            experts,
            EMBEDDING,
            tokens,
            experts->nb[2],
            static_cast<size_t>(lane) * experts->nb[1]
        );
        output = ggml_add(context, output, selected);
    }
    output = ggml_cont(context, output);
    ggml_set_name(output, "cached_moe_output");

    ggml_backend_buffer_t buffer =
        ggml_backend_alloc_ctx_tensors(context, backend);
    if (!buffer) {
        std::cerr << "Could not allocate MoE graph on "
                  << ggml_backend_name(backend) << "\n";
        ggml_free(context);
        std::exit(1);
    }
    ggml_backend_buffer_set_usage(
        buffer,
        GGML_BACKEND_BUFFER_USAGE_WEIGHTS
    );
    RunResult result;
    result.backend = ggml_backend_name(backend);
    if (mapped_weights) {
        ggml_backend_tensor_set(
            gate_biases,
            gate_data.biases.data(),
            0,
            gate_data.biases.size() * sizeof(float)
        );
        ggml_backend_tensor_set(
            up_biases,
            up_data.biases.data(),
            0,
            up_data.biases.size() * sizeof(float)
        );
        ggml_backend_tensor_set(
            down_biases,
            down_data.biases.data(),
            0,
            down_data.biases.size() * sizeof(float)
        );
        result.weight_fill_ms = fill_mapped_weights(
            *mapped_weights,
            expert_ids,
            gate_weights,
            up_weights,
            down_weights
        );
        result.mapped_file_buffers = 3;
    } else {
        set_projection(gate_weights, gate_biases, gate_data);
        set_projection(up_weights, up_biases, up_data);
        set_projection(down_weights, down_biases, down_data);
    }

    std::vector<int32_t> ids(
        static_cast<size_t>(slots) * tokens
    );
    for (int token = 0; token < tokens; ++token) {
        for (int lane = 0; lane < EXPERTS_USED; ++lane) {
            ids[static_cast<size_t>(token) * slots + lane] = lane;
        }
    }
    ggml_backend_tensor_set(
        all_ids,
        ids.data(),
        0,
        ids.size() * sizeof(ids.front())
    );

    std::vector<float> input_values(
        static_cast<size_t>(EMBEDDING) * tokens
    );
    for (size_t index = 0; index < input_values.size(); ++index) {
        input_values[index] =
            std::sin(static_cast<float>(index % EMBEDDING) * 0.013f) * 0.25f +
            std::cos(static_cast<float>(index % 97) * 0.031f) * 0.05f;
    }
    ggml_backend_tensor_set(
        input,
        input_values.data(),
        0,
        input_values.size() * sizeof(input_values.front())
    );

    const float lane_weights[EXPERTS_USED] = {0.4f, 0.3f, 0.2f, 0.1f};
    std::vector<float> routing(
        static_cast<size_t>(EXPERTS_USED) * tokens
    );
    for (int token = 0; token < tokens; ++token) {
        std::copy(
            lane_weights,
            lane_weights + EXPERTS_USED,
            routing.begin() +
                static_cast<size_t>(token) * EXPERTS_USED
        );
    }
    ggml_backend_tensor_set(
        route_weights,
        routing.data(),
        0,
        routing.size() * sizeof(routing.front())
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
        std::cerr << "Complete MoE graph failed on "
                  << ggml_backend_name(backend) << ": "
                  << ggml_status_to_string(status) << "\n";
        ggml_backend_buffer_free(buffer);
        ggml_free(context);
        std::exit(1);
    }

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
    const ProjectionData & gate,
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
    NSMutableArray * expert_ids = [NSMutableArray array];
    for (int value : options.expert_ids) {
        [expert_ids addObject:@(value)];
    }
    const size_t projection_pool =
        gate.weight_bytes_per_slot * options.expert_ids.size();
    const size_t bias_pool =
        static_cast<size_t>(EXPERT_FF) * sizeof(float) *
        options.expert_ids.size();
    return @{
        @"schema": @"amos.expert-moe-slot-equivalence",
        @"version": @1,
        @"model": [NSString stringWithUTF8String:options.model.c_str()],
        @"layer": @(options.layer),
        @"expert_ids": expert_ids,
        @"compact_slot_ids": @[@0, @1, @2, @3],
        @"selected_per_token": @(EXPERTS_USED),
        @"tokens": @(options.tokens),
        @"weight_bytes_per_expert_projection":
            @(gate.weight_bytes_per_slot),
        @"three_projection_slot_pool_bytes": @(projection_pool * 3),
        @"three_projection_bias_pool_bytes": @(bias_pool * 3),
        @"total_cached_expert_bytes":
            @(projection_pool * 3 + bias_pool * 3),
        @"operations": @[
            @"MXFP4 gate MUL_MAT_ID + selected bias",
            @"MXFP4 up MUL_MAT_ID + selected bias",
            @"OpenAI MoE SwiGLU alpha=1.702 limit=7.0",
            @"MXFP4 down MUL_MAT_ID + selected bias",
            @"routing-weight application",
            @"four-expert aggregation"
        ],
        @"cpu_backend":
            [NSString stringWithUTF8String:cpu.backend.c_str()],
        @"metal_backend":
            [NSString stringWithUTF8String:metal.backend.c_str()],
        @"cpu_elapsed_ms": @(cpu.elapsed_ms),
        @"metal_elapsed_ms": @(metal.elapsed_ms),
        @"metal_weight_fill_ms": @(metal.weight_fill_ms),
        @"metal_mapped_file_buffers": @(metal.mapped_file_buffers),
        @"metal_weight_fill_path":
            @"mmap GGUF -> no-copy MTLBuffer -> MTLBlit -> ggml slot tensor",
        @"output_elements": @(cpu.output.size()),
        @"finite": @(finite),
        @"nmse": @(nmse),
        @"max_absolute_error": @(max_absolute_error),
        @"equivalence_threshold_nmse": @5e-4,
        @"equivalent": @(equivalent),
        @"gate": equivalent ? @"PASS" : @"FAIL",
        @"scope": @[
            @"real routed GPT-OSS 120B expert weights and biases",
            @"bounded four-expert slot pool",
            @"compact slot IDs",
            @"complete selected-expert feed-forward block",
            @"Metal output compared with CPU reference"
        ],
        @"not_yet_proven": @[
            @"GPU-resident expert-to-slot resolver",
            @"router computation and slot population in one command stream",
            @"all 36 transformer layers",
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
        const int file = open(options.model.c_str(), O_RDONLY);
        if (file < 0) {
            perror("open model");
            return 1;
        }
        const ProjectionData gate = load_projection(
            file,
            experts,
            options.expert_ids,
            "gate"
        );
        const ProjectionData up = load_projection(
            file,
            experts,
            options.expert_ids,
            "up"
        );
        const ProjectionData down = load_projection(
            file,
            experts,
            options.expert_ids,
            "down"
        );
        close(file);

        ggml_backend_t cpu = ggml_backend_cpu_init();
        ggml_backend_t metal = ggml_backend_metal_init();
        if (!cpu || !metal) {
            std::cerr << "Could not initialize CPU and Metal backends\n";
            if (cpu) ggml_backend_free(cpu);
            if (metal) ggml_backend_free(metal);
            return 1;
        }
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device) {
            std::cerr << "Metal is not available\n";
            ggml_backend_free(cpu);
            ggml_backend_free(metal);
            return 1;
        }
        const MetalMappedWeights mapped_weights =
            map_all_projections(device, options.model, experts);
        const RunResult cpu_result = run_graph(
            cpu,
            gate,
            up,
            down,
            options.tokens,
            nullptr,
            options.expert_ids
        );
        const RunResult metal_result = run_graph(
            metal,
            gate,
            up,
            down,
            options.tokens,
            &mapped_weights,
            options.expert_ids
        );
        NSDictionary * report = build_report(
            options,
            gate,
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
