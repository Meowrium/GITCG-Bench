// Copyright (C) 2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

// MCP Protocol constants and message builders for JSON-RPC 2.0 communication
// Based on MCPTheSpire's MCPProtocol.java

export const JSONRPC_VERSION = "2.0";
export const MCP_VERSION = "2024-11-05";

// MCP Methods
export const METHOD_INITIALIZE = "initialize";
export const METHOD_INITIALIZED = "notifications/initialized";
export const METHOD_TOOLS_LIST = "tools/list";
export const METHOD_TOOLS_CALL = "tools/call";
export const METHOD_PING = "ping";

// Error codes
export const ERROR_PARSE = -32700;
export const ERROR_INVALID_REQUEST = -32600;
export const ERROR_METHOD_NOT_FOUND = -32601;
export const ERROR_INVALID_PARAMS = -32602;
export const ERROR_INTERNAL = -32603;

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id?: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
}

export function parseRequest(json: string): JsonRpcRequest {
  return JSON.parse(json);
}

export function getMethod(request: JsonRpcRequest): string | undefined {
  return request.method;
}

export function getId(request: JsonRpcRequest): string | number | undefined {
  return request.id;
}

export function getParams(request: JsonRpcRequest): Record<string, unknown> | undefined {
  return request.params;
}

export function buildResponse(id: string | number | undefined, result: unknown): string {
  const response: JsonRpcResponse = {
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  };
  return JSON.stringify(response);
}

export function buildErrorResponse(
  id: string | number | undefined,
  code: number,
  message: string
): string {
  const response: JsonRpcResponse = {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code,
      message,
    },
  };
  return JSON.stringify(response);
}

export function buildInitializeResult(serverName: string, serverVersion: string) {
  return {
    protocolVersion: MCP_VERSION,
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: serverName,
      version: serverVersion,
    },
  };
}

export function buildToolsListResult(tools: ToolDefinition[]) {
  return {
    tools,
  };
}

export function buildToolCallResult(text: string, isError = false): ToolCallResult {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    isError,
  };
}

export function buildToolCallResultJson(data: unknown): ToolCallResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data),
      },
    ],
  };
}

export function createToolDefinition(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>
): ToolDefinition {
  return {
    name,
    description,
    inputSchema,
  };
}

export function createInputSchema(
  properties: Record<string, unknown>,
  required?: string[]
) {
  const schema: Record<string, unknown> = {
    type: "object",
    properties,
  };
  if (required && required.length > 0) {
    schema.required = required;
  }
  return schema;
}

export function createProperty(type: string, description: string) {
  return {
    type,
    description,
  };
}

export function createEnumProperty(description: string, values: string[]) {
  return {
    type: "string",
    description,
    enum: values,
  };
}
