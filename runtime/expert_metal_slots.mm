#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <fcntl.h>
#include <fstream>
#include <iostream>
#include <map>
#include <numeric>
#include <string>
#include <sys/mman.h>
#include <unistd.h>
#include <vector>

namespace {

struct ByteRange {
    off_t offset;
    size_t length;
};

struct Expert {
    std::vector<ByteRange> ranges;
    size_t bytes = 0;
};

struct TokenRoute {
    std::string workflow;
    std::vector<int> experts;
};

struct Options {
    std::string model;
    std::string layout;
    std::string trace;
    std::string output;
    std::string load_mode = "pread";
    int layer = 0;
    int slots = 8;
    int max_tokens = 0;
    int probe_threads = 4096;
};

struct SlotCache {
    explicit SlotCache(int capacity)
        : expert_by_slot(capacity, -1), last_used(capacity, 0) {}

    int access(int expert, uint64_t ordinal, bool & hit) {
        const auto existing = slot_by_expert.find(expert);
        if (existing != slot_by_expert.end()) {
            hit = true;
            last_used[existing->second] = ordinal;
            return existing->second;
        }
        hit = false;
        int slot = -1;
        for (size_t index = 0; index < expert_by_slot.size(); ++index) {
            if (expert_by_slot[index] < 0) {
                slot = static_cast<int>(index);
                break;
            }
        }
        if (slot < 0) {
            slot = static_cast<int>(
                std::min_element(last_used.begin(), last_used.end()) -
                last_used.begin()
            );
            slot_by_expert.erase(expert_by_slot[slot]);
        }
        expert_by_slot[slot] = expert;
        last_used[slot] = ordinal;
        slot_by_expert[expert] = slot;
        return slot;
    }

    std::vector<int> expert_by_slot;
    std::vector<uint64_t> last_used;
    std::map<int, int> slot_by_expert;
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
    result.trace = required(args, "--trace");
    result.output = option(args, "--output");
    const std::string load_mode = option(args, "--load-mode");
    if (!load_mode.empty()) result.load_mode = load_mode;
    if (result.load_mode != "pread" &&
        result.load_mode != "metal-fallback") {
        std::cerr << "--load-mode must be pread or metal-fallback\n";
        std::exit(2);
    }
    result.layer = integer_option(args, "--layer", 0, 0, 255);
    result.slots = integer_option(args, "--slots", 8, 4, 128);
    result.max_tokens = integer_option(
        args, "--max-tokens", 0, 0, 1'000'000
    );
    result.probe_threads = integer_option(
        args, "--probe-threads", 4096, 64, 65536
    );
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
    int layer,
    size_t & expert_bytes
) {
    NSDictionary * root = read_json_object(path);
    NSArray * layers = root[@"layers"];
    if (![layers isKindOfClass:[NSArray class]] ||
        layer >= static_cast<int>([layers count])) {
        std::cerr << "Layout does not contain layer " << layer << "\n";
        std::exit(1);
    }
    NSDictionary * selected_layer = layers[layer];
    NSArray * values = selected_layer[@"experts"];
    expert_bytes = [root[@"bytes_per_layer_expert"] unsignedLongLongValue];
    std::vector<Expert> experts([values count]);
    for (NSDictionary * value in values) {
        const int expert_id = [value[@"expert"] intValue];
        Expert expert;
        expert.bytes = [value[@"bytes"] unsignedLongLongValue];
        for (NSDictionary * range in value[@"ranges"]) {
            expert.ranges.push_back({
                static_cast<off_t>([range[@"offset"] longLongValue]),
                static_cast<size_t>([range[@"length"] unsignedLongLongValue])
            });
        }
        if (expert.bytes != expert_bytes || expert_id < 0 ||
            expert_id >= static_cast<int>(experts.size())) {
            std::cerr << "Invalid expert layout entry at layer " << layer << "\n";
            std::exit(1);
        }
        experts[expert_id] = std::move(expert);
    }
    return experts;
}

std::vector<TokenRoute> load_routes(
    const std::string & path,
    int layer,
    int max_tokens
) {
    std::ifstream input(path);
    if (!input) {
        std::cerr << "Could not open trace " << path << "\n";
        std::exit(1);
    }
    std::vector<TokenRoute> routes;
    std::string line;
    while (std::getline(input, line)) {
        @autoreleasepool {
            NSData * data = [
                [NSString stringWithUTF8String:line.c_str()]
                dataUsingEncoding:NSUTF8StringEncoding
            ];
            id value = parse_json(data, "trace line");
            if (![value isKindOfClass:[NSDictionary class]]) continue;
            NSDictionary * record = (NSDictionary *)value;
            if (![record[@"type"] isEqual:@"token"] ||
                ![record[@"phase"] isEqual:@"decode"]) {
                continue;
            }
            NSArray * layers = record[@"experts"];
            if (layer >= static_cast<int>([layers count])) {
                std::cerr << "Trace token does not contain layer " << layer << "\n";
                std::exit(1);
            }
            TokenRoute route;
            route.workflow = [record[@"workflow"] UTF8String];
            for (NSNumber * expert in layers[layer]) {
                route.experts.push_back([expert intValue]);
            }
            routes.push_back(std::move(route));
            if (max_tokens > 0 &&
                static_cast<int>(routes.size()) >= max_tokens) {
                break;
            }
        }
    }
    if (routes.empty()) {
        std::cerr << "Trace contains no selected decode routes\n";
        std::exit(1);
    }
    return routes;
}

double percentile(std::vector<double> values, double quantile) {
    if (values.empty()) return 0;
    std::sort(values.begin(), values.end());
    const double position = quantile * static_cast<double>(values.size() - 1);
    const size_t lower = static_cast<size_t>(position);
    const size_t upper = std::min(values.size() - 1, lower + 1);
    const double fraction = position - static_cast<double>(lower);
    return values[lower] + (values[upper] - values[lower]) * fraction;
}

void read_expert(
    int file,
    const Expert & expert,
    uint8_t * destination
) {
    size_t written = 0;
    for (const ByteRange & range : expert.ranges) {
        size_t remaining = range.length;
        off_t offset = range.offset;
        while (remaining > 0) {
            const ssize_t count = pread(
                file, destination + written, remaining, offset
            );
            if (count <= 0) {
                perror("pread expert");
                std::exit(1);
            }
            written += static_cast<size_t>(count);
            remaining -= static_cast<size_t>(count);
            offset += count;
        }
    }
    if (written != expert.bytes) {
        std::cerr << "Expert read wrote " << written << " bytes, expected "
                  << expert.bytes << "\n";
        std::exit(1);
    }
}

struct FallbackRange {
    size_t buffer_index;
    size_t data_offset;
    size_t expert_bytes;
    size_t slot_offset;
};

std::vector<FallbackRange> create_metal_fallbacks(
    id<MTLDevice> device,
    int file,
    const std::vector<Expert> & experts,
    NSMutableArray * buffers
) {
    const long page_size = sysconf(_SC_PAGESIZE);
    std::vector<FallbackRange> fallbacks;
    size_t slot_offset = 0;
    const size_t range_count = experts.front().ranges.size();
    for (size_t range_index = 0; range_index < range_count; ++range_index) {
        const ByteRange & first = experts.front().ranges[range_index];
        const ByteRange & last = experts.back().ranges[range_index];
        const off_t data_start = first.offset;
        const off_t data_end = last.offset + static_cast<off_t>(last.length);
        const off_t map_start =
            data_start - (data_start % static_cast<off_t>(page_size));
        const size_t data_offset = static_cast<size_t>(data_start - map_start);
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
            perror("mmap fallback tensor");
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
            std::cerr << "Could not wrap mapped expert tensor in Metal buffer\n";
            std::exit(1);
        }
        [buffers addObject:buffer];
        fallbacks.push_back({
            static_cast<size_t>([buffers count] - 1),
            data_offset,
            first.length,
            slot_offset
        });
        slot_offset += first.length;
    }
    return fallbacks;
}

NSString * metal_source() {
    return @R"METAL(
        #include <metal_stdlib>
        using namespace metal;
        kernel void probe_expert(
            device const uint * pool [[buffer(0)]],
            device uint * digest [[buffer(1)]],
            constant ulong & word_offset [[buffer(2)]],
            constant ulong & word_count [[buffer(3)]],
            constant uint & thread_count [[buffer(4)]],
            uint gid [[thread_position_in_grid]]
        ) {
            uint value = 0;
            for (ulong index = gid; index < word_count; index += thread_count) {
                value ^= pool[word_offset + index];
            }
            digest[gid] = value;
        }
    )METAL";
}

} // namespace

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        const Options options = parse_options(argc, argv);
        size_t expert_bytes = 0;
        const std::vector<Expert> experts =
            load_layout(options.layout, options.layer, expert_bytes);
        const std::vector<TokenRoute> routes =
            load_routes(options.trace, options.layer, options.max_tokens);
        if (options.slots > static_cast<int>(experts.size()) ||
            expert_bytes % sizeof(uint32_t) != 0) {
            std::cerr << "Invalid slot count or expert alignment\n";
            return 2;
        }

        const int model_fd = open(options.model.c_str(), O_RDONLY);
        if (model_fd < 0) {
            perror("open model");
            return 1;
        }
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device) {
            std::cerr << "Metal is not available\n";
            close(model_fd);
            return 1;
        }
        const size_t pool_bytes =
            static_cast<size_t>(options.slots) * expert_bytes;
        const MTLResourceOptions pool_options =
            options.load_mode == "metal-fallback"
                ? MTLResourceStorageModePrivate
                : MTLResourceStorageModeShared;
        id<MTLBuffer> pool = [device
            newBufferWithLength:pool_bytes
            options:pool_options
        ];
        id<MTLBuffer> digest = [device
            newBufferWithLength:
                static_cast<size_t>(options.probe_threads) * sizeof(uint32_t)
            options:MTLResourceStorageModeShared
        ];
        if (!pool || !digest) {
            std::cerr << "Could not allocate fixed Metal slot buffers\n";
            close(model_fd);
            return 1;
        }
        NSMutableArray * fallback_buffers = [NSMutableArray array];
        std::vector<FallbackRange> fallback_ranges;
        if (options.load_mode == "metal-fallback") {
            fallback_ranges = create_metal_fallbacks(
                device,
                model_fd,
                experts,
                fallback_buffers
            );
        }

        NSError * error = nil;
        id<MTLLibrary> library = [
            device newLibraryWithSource:metal_source() options:nil error:&error
        ];
        id<MTLFunction> function =
            [library newFunctionWithName:@"probe_expert"];
        id<MTLComputePipelineState> pipeline = [
            device newComputePipelineStateWithFunction:function error:&error
        ];
        id<MTLCommandQueue> queue = [device newCommandQueue];
        if (!library || !pipeline || !queue || error) {
            std::cerr << "Could not initialize Metal probe: "
                      << [[error localizedDescription] UTF8String] << "\n";
            close(model_fd);
            return 1;
        }

        SlotCache cache(options.slots);
        uint64_t access_ordinal = 0;
        uint64_t hits = 0;
        uint64_t misses = 0;
        uint64_t bytes_loaded = 0;
        std::vector<double> load_ms;
        std::vector<double> gpu_ms;
        std::vector<double> gpu_hit_only_ms;
        std::vector<double> gpu_miss_ms;
        std::map<std::string, uint64_t> workflow_tokens;
        const auto experiment_start = std::chrono::steady_clock::now();

        for (const TokenRoute & route : routes) {
            workflow_tokens[route.workflow] += 1;
            std::vector<int> selected_slots;
            std::vector<std::pair<int, int>> fills;
            for (int expert_id : route.experts) {
                if (expert_id < 0 ||
                    expert_id >= static_cast<int>(experts.size())) {
                    std::cerr << "Trace selected invalid expert\n";
                    close(model_fd);
                    return 1;
                }
                bool hit = false;
                const int slot = cache.access(
                    expert_id, ++access_ordinal, hit
                );
                if (hit) {
                    hits += 1;
                } else {
                    misses += 1;
                    if (options.load_mode == "pread") {
                        const auto started = std::chrono::steady_clock::now();
                        read_expert(
                            model_fd,
                            experts[expert_id],
                            static_cast<uint8_t *>([pool contents]) +
                                static_cast<size_t>(slot) * expert_bytes
                        );
                        const auto stopped = std::chrono::steady_clock::now();
                        load_ms.push_back(
                            std::chrono::duration<double, std::milli>(
                                stopped - started
                            ).count()
                        );
                    } else {
                        fills.push_back({expert_id, slot});
                    }
                    bytes_loaded += expert_bytes;
                }
                selected_slots.push_back(slot);
            }

            std::fill_n(
                static_cast<uint32_t *>([digest contents]),
                options.probe_threads,
                0
            );
            id<MTLCommandBuffer> command = [queue commandBuffer];
            if (!fills.empty()) {
                id<MTLBlitCommandEncoder> blit =
                    [command blitCommandEncoder];
                for (const auto & fill : fills) {
                    const int expert_id = fill.first;
                    const int slot = fill.second;
                    for (const FallbackRange & range : fallback_ranges) {
                        id<MTLBuffer> source = [
                            fallback_buffers objectAtIndex:range.buffer_index
                        ];
                        [blit copyFromBuffer:source
                              sourceOffset:
                                range.data_offset +
                                static_cast<size_t>(expert_id) *
                                    range.expert_bytes
                                  toBuffer:pool
                         destinationOffset:
                            static_cast<size_t>(slot) * expert_bytes +
                            range.slot_offset
                                     size:range.expert_bytes];
                    }
                }
                [blit endEncoding];
            }
            id<MTLComputeCommandEncoder> encoder =
                [command computeCommandEncoder];
            [encoder setComputePipelineState:pipeline];
            [encoder setBuffer:pool offset:0 atIndex:0];
            [encoder setBuffer:digest offset:0 atIndex:1];
            const uint64_t word_count = expert_bytes / sizeof(uint32_t);
            const uint32_t thread_count =
                static_cast<uint32_t>(options.probe_threads);
            for (int slot : selected_slots) {
                const uint64_t word_offset =
                    static_cast<uint64_t>(slot) * word_count;
                [encoder setBytes:&word_offset
                           length:sizeof(word_offset)
                          atIndex:2];
                [encoder setBytes:&word_count
                           length:sizeof(word_count)
                          atIndex:3];
                [encoder setBytes:&thread_count
                           length:sizeof(thread_count)
                          atIndex:4];
                const NSUInteger width = std::min<NSUInteger>(
                    options.probe_threads,
                    [pipeline maxTotalThreadsPerThreadgroup]
                );
                [encoder dispatchThreads:
                    MTLSizeMake(options.probe_threads, 1, 1)
                    threadsPerThreadgroup:MTLSizeMake(width, 1, 1)
                ];
            }
            [encoder endEncoding];
            [command commit];
            [command waitUntilCompleted];
            if ([command status] != MTLCommandBufferStatusCompleted) {
                std::cerr << "Metal slot probe failed: "
                          << [[[command error] localizedDescription] UTF8String]
                          << "\n";
                close(model_fd);
                return 1;
            }
            const double token_gpu_ms =
                ([command GPUEndTime] - [command GPUStartTime]) * 1'000.0;
            gpu_ms.push_back(token_gpu_ms);
            if (fills.empty()) {
                gpu_hit_only_ms.push_back(token_gpu_ms);
            } else {
                gpu_miss_ms.push_back(token_gpu_ms);
            }
        }

        const double elapsed_seconds = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - experiment_start
        ).count();
        const double hit_rate = hits + misses > 0
            ? static_cast<double>(hits) / static_cast<double>(hits + misses)
            : 0;
        NSMutableDictionary * workflows = [NSMutableDictionary dictionary];
        for (const auto & entry : workflow_tokens) {
            workflows[
                [NSString stringWithUTF8String:entry.first.c_str()]
            ] = @(entry.second);
        }
        NSDictionary * report = @{
            @"schema": @"amos.expert-metal-slot-probe",
            @"version": @1,
            @"device": [device name],
            @"layer": @(options.layer),
            @"load_mode":
                [NSString stringWithUTF8String:options.load_mode.c_str()],
            @"slot_count": @(options.slots),
            @"expert_count": @(experts.size()),
            @"expert_bytes": @(expert_bytes),
            @"pool_bytes": @(pool_bytes),
            @"pool_cpu_address":
                [NSString stringWithFormat:@"%p", [pool contents]],
            @"pool_gpu_address": @([pool gpuAddress]),
            @"fallback_buffer_count": @([fallback_buffers count]),
            @"metal_allocation_count": @(2 + [fallback_buffers count]),
            @"decode_tokens": @(routes.size()),
            @"selected_expert_accesses": @(hits + misses),
            @"hits": @(hits),
            @"misses": @(misses),
            @"hit_rate": @(hit_rate),
            @"bytes_loaded": @(bytes_loaded),
            @"load_ms": @{
                @"mean": @(load_ms.empty() ? 0 :
                    std::accumulate(load_ms.begin(), load_ms.end(), 0.0) /
                    static_cast<double>(load_ms.size())),
                @"p50": @(percentile(load_ms, 0.50)),
                @"p95": @(percentile(load_ms, 0.95)),
                @"p99": @(percentile(load_ms, 0.99))
            },
            @"gpu_probe_ms_per_token": @{
                @"mean": @(gpu_ms.empty() ? 0 :
                    std::accumulate(gpu_ms.begin(), gpu_ms.end(), 0.0) /
                    static_cast<double>(gpu_ms.size())),
                @"p50": @(percentile(gpu_ms, 0.50)),
                @"p95": @(percentile(gpu_ms, 0.95)),
                @"p99": @(percentile(gpu_ms, 0.99))
            },
            @"gpu_hit_only_ms_per_token": @{
                @"tokens": @(gpu_hit_only_ms.size()),
                @"mean": @(gpu_hit_only_ms.empty() ? 0 :
                    std::accumulate(
                        gpu_hit_only_ms.begin(),
                        gpu_hit_only_ms.end(),
                        0.0
                    ) / static_cast<double>(gpu_hit_only_ms.size())),
                @"p50": @(percentile(gpu_hit_only_ms, 0.50)),
                @"p95": @(percentile(gpu_hit_only_ms, 0.95))
            },
            @"gpu_miss_ms_per_token": @{
                @"tokens": @(gpu_miss_ms.size()),
                @"mean": @(gpu_miss_ms.empty() ? 0 :
                    std::accumulate(
                        gpu_miss_ms.begin(),
                        gpu_miss_ms.end(),
                        0.0
                    ) / static_cast<double>(gpu_miss_ms.size())),
                @"p50": @(percentile(gpu_miss_ms, 0.50)),
                @"p95": @(percentile(gpu_miss_ms, 0.95))
            },
            @"elapsed_seconds": @(elapsed_seconds),
            @"cache_specific_hit_path_allocations": @0,
            @"cache_specific_hit_path_uploads": @0,
            @"benchmark_waits_for_gpu_timing": @(routes.size()),
            @"workflows": workflows,
            @"note": @"Transport/residency probe only; not model inference."
        };
        NSData * report_data = [
            NSJSONSerialization dataWithJSONObject:report
            options:NSJSONWritingPrettyPrinted
            error:&error
        ];
        if (!report_data || error) {
            std::cerr << "Could not serialize report\n";
            close(model_fd);
            return 1;
        }
        if (!options.output.empty() && ![report_data writeToFile:
            [NSString stringWithUTF8String:options.output.c_str()]
            atomically:YES
        ]) {
            std::cerr << "Could not write report " << options.output << "\n";
            close(model_fd);
            return 1;
        }
        std::cout << std::string(
            static_cast<const char *>([report_data bytes]),
            [report_data length]
        ) << "\n";
        close(model_fd);
        return 0;
    }
}
