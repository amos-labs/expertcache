#!/usr/bin/env python3
"""Expose Amazon Bedrock Converse as a local OpenAI-shaped benchmark endpoint."""

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import boto3


def openai_messages_to_bedrock(messages):
    system = []
    converted = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            system.append({"text": str(message.get("content") or "")})
            continue
        if role == "tool":
            raw = message.get("content") or ""
            try:
                value = json.loads(raw)
                result_content = [{"json": value}]
            except (TypeError, json.JSONDecodeError):
                result_content = [{"text": str(raw)}]
            converted.append({
                "role": "user",
                "content": [{
                    "toolResult": {
                        "toolUseId": str(message.get("tool_call_id") or ""),
                        "content": result_content,
                    }
                }],
            })
            continue

        content = []
        if message.get("content"):
            content.append({"text": str(message["content"])})
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            raw_arguments = function.get("arguments") or {}
            if isinstance(raw_arguments, str):
                try:
                    arguments = json.loads(raw_arguments)
                except json.JSONDecodeError:
                    arguments = {}
            else:
                arguments = raw_arguments
            content.append({
                "toolUse": {
                    "toolUseId": str(call.get("id") or ""),
                    "name": str(function.get("name") or ""),
                    "input": arguments,
                }
            })
        converted.append({
            "role": "assistant" if role == "assistant" else "user",
            "content": content or [{"text": ""}],
        })
    return system, converted


def openai_tools_to_bedrock(tools):
    converted = []
    for tool in tools or []:
        function = tool.get("function") or {}
        converted.append({
            "toolSpec": {
                "name": str(function.get("name") or ""),
                "description": str(
                    function.get("description") or function.get("name") or ""
                ),
                "inputSchema": {
                    "json": function.get("parameters") or {"type": "object"}
                },
            }
        })
    return {"tools": converted} if converted else None


def bedrock_response_to_openai(payload, model):
    message = (payload.get("output") or {}).get("message") or {}
    text = []
    tool_calls = []
    for block in message.get("content") or []:
        if "text" in block:
            text.append(block["text"])
        tool_use = block.get("toolUse")
        if tool_use:
            tool_calls.append({
                "id": tool_use.get("toolUseId"),
                "type": "function",
                "function": {
                    "name": tool_use.get("name"),
                    "arguments": json.dumps(
                        tool_use.get("input") or {}, separators=(",", ":")
                    ),
                },
            })
    usage = payload.get("usage") or {}
    latency_ms = (payload.get("metrics") or {}).get("latencyMs") or 0
    stop_reason = {
        "end_turn": "stop",
        "tool_use": "tool_calls",
        "max_tokens": "length",
    }.get(payload.get("stopReason"), payload.get("stopReason"))
    return {
        "model": model,
        "choices": [{
            "index": 0,
            "finish_reason": stop_reason,
            "message": {
                "role": "assistant",
                "content": "".join(text) or None,
                "tool_calls": tool_calls or None,
            },
        }],
        "usage": {
            "prompt_tokens": usage.get("inputTokens", 0),
            "completion_tokens": usage.get("outputTokens", 0),
            "total_tokens": usage.get("totalTokens", 0),
        },
        "timings": {
            "predicted_n": usage.get("outputTokens", 0),
            "predicted_ms": latency_ms,
        },
    }


class GatewayHandler(BaseHTTPRequestHandler):
    server_version = "ExpertCacheBedrockBenchmark/1"

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"status": "ok"})
            return
        if self.path == "/v1/models":
            self.send_json(200, {
                "data": [{"id": self.server.model_id, "object": "model"}],
                "object": "list",
            })
            return
        self.send_json(404, {"error": {"message": "Not found"}})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_json(404, {"error": {"message": "Not found"}})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            request = json.loads(self.rfile.read(length) or b"{}")
            system, messages = openai_messages_to_bedrock(
                request.get("messages") or []
            )
            arguments = {
                "modelId": request.get("model") or self.server.model_id,
                "messages": messages,
                "inferenceConfig": {
                    "maxTokens": int(request.get("max_tokens") or 768),
                    "temperature": float(request.get("temperature") or 0),
                },
            }
            model_fields = {}
            reasoning_effort = request.get("reasoning_effort")
            if reasoning_effort:
                model_fields["reasoning_effort"] = str(reasoning_effort)
            if request.get("seed") is not None:
                model_fields["seed"] = int(request["seed"])
            if model_fields:
                arguments["additionalModelRequestFields"] = model_fields
            if system:
                arguments["system"] = system
            tool_config = openai_tools_to_bedrock(request.get("tools"))
            if tool_config:
                arguments["toolConfig"] = tool_config
            response = self.server.bedrock.converse(**arguments)
            self.send_json(
                200,
                bedrock_response_to_openai(response, arguments["modelId"]),
            )
        except Exception as error:
            print(f"Bedrock request failed: {error}", file=sys.stderr, flush=True)
            self.send_json(500, {"error": {"message": str(error)}})

    def log_message(self, template, *args):
        print(template % args, file=sys.stderr, flush=True)

    def send_json(self, status, payload):
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=11440)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--model", default="openai.gpt-oss-120b-1:0")
    arguments = parser.parse_args()

    server = ThreadingHTTPServer(
        (arguments.host, arguments.port),
        GatewayHandler,
    )
    server.bedrock = boto3.Session(
        region_name=arguments.region
    ).client("bedrock-runtime")
    server.model_id = arguments.model
    print(
        f"ExpertCache Bedrock benchmark gateway listening on "
        f"http://{arguments.host}:{arguments.port} for {arguments.model}",
        file=sys.stderr,
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
