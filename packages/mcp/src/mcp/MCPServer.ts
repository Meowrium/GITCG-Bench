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

import type {
  JsonRpcRequest,
  JsonRpcResponse,
} from "./MCPProtocol";
import {
  parseRequest,
  getMethod,
  getId,
  getParams,
  buildResponse,
  buildErrorResponse,
  buildInitializeResult,
  buildToolsListResult,
  ERROR_PARSE,
  ERROR_INVALID_REQUEST,
  ERROR_METHOD_NOT_FOUND,
  ERROR_INVALID_PARAMS,
  ERROR_INTERNAL,
  METHOD_INITIALIZE,
  METHOD_INITIALIZED,
  METHOD_TOOLS_LIST,
  METHOD_TOOLS_CALL,
  METHOD_PING,
} from "./MCPProtocol";
import { MCPToolHandler } from "./MCPToolHandler";

const SERVER_NAME = "MCPGTCG";
const SERVER_VERSION = "1.0.0";

interface PendingToolCall {
  id: string | number;
  toolName: string;
  args: Record<string, unknown>;
}

export class MCPServer {
  private toolHandler: MCPToolHandler;
  private initialized = false;
  private running = false;
  private sessionId: string | null = null;

  constructor() {
    this.toolHandler = new MCPToolHandler();
  }

  getToolHandler(): MCPToolHandler {
    return this.toolHandler;
  }

  async start(): Promise<void> {
    this.running = true;
    console.error(`MCP Server ${SERVER_NAME} v${SERVER_VERSION} started`);

    // Only listen to stdin in Node.js environment
    if (typeof process !== "undefined" && process.stdin) {
      process.stdin.on("data", (data) => {
        this.handleInput(data.toString());
      });

      process.stdin.on("end", () => {
        this.stop();
      });

      process.stdin.on("error", (err) => {
        console.error("stdin error:", err);
        this.stop();
      });
    }
  }

  stop(): void {
    this.running = false;
    console.error("MCP Server stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  private handleInput(input: string): void {
    try {
      const lines = input.split("\n").filter((line) => line.trim() !== "");

      for (const line of lines) {
        this.handleMessage(line);
      }
    } catch (e) {
      console.error("Error handling input:", e);
    }
  }

  private handleMessage(message: string): void {
    let request: JsonRpcRequest;
    try {
      request = parseRequest(message);
    } catch (e) {
      const error = e as Error;
      this.sendResponse(
        buildErrorResponse(undefined, ERROR_PARSE, `Parse error: ${error.message}`)
      );
      return;
    }

    const method = getMethod(request);
    const id = getId(request);
    const params = getParams(request);

    console.error(`MCP method: ${method}, id: ${id}`);

    if (id === undefined) {
      if (METHOD_INITIALIZED === method) {
        console.error("Client initialized notification received");
      }
      return;
    }

    if (method === undefined) {
      this.sendResponse(
        buildErrorResponse(id, ERROR_INVALID_REQUEST, "Missing method")
      );
      return;
    }

    this.handleMethodAsync(method, id, params);
  }

  private async handleMethodAsync(
    method: string,
    id: string | number,
    params: Record<string, unknown> | undefined
  ): Promise<void> {
    let response: string;
    switch (method) {
      case METHOD_INITIALIZE:
        response = this.handleInitialize(id, params);
        break;
      case METHOD_TOOLS_LIST:
        response = this.handleToolsList(id);
        break;
      case METHOD_TOOLS_CALL:
        response = await this.handleToolsCall(id, params);
        break;
      case METHOD_PING:
        response = buildResponse(id, {});
        break;
      default:
        response = buildErrorResponse(
          id,
          ERROR_METHOD_NOT_FOUND,
          `Unknown method: ${method}`
        );
    }

    this.sendResponse(response);
  }

  private sendResponse(response: string): void {
    console.log(response);
  }

  private handleInitialize(
    id: string | number,
    params: Record<string, unknown> | undefined
  ): string {
    // Use fallback for crypto.randomUUID if not available
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      this.sessionId = crypto.randomUUID();
    } else {
      this.sessionId = "sess_" + Math.random().toString(36).substring(2, 15) + 
                      Math.random().toString(36).substring(2, 15);
    }
    this.initialized = true;

    const result = buildInitializeResult(SERVER_NAME, SERVER_VERSION);
    console.error(`MCP initialized, session: ${this.sessionId}`);
    return buildResponse(id, result);
  }

  private handleToolsList(id: string | number): string {
    const tools = this.toolHandler.getToolDefinitions();
    const result = buildToolsListResult(tools);
    return buildResponse(id, result);
  }

  private async handleToolsCall(
    id: string | number,
    params: Record<string, unknown> | undefined
  ): Promise<string> {
    if (!params || !params.name) {
      return buildErrorResponse(
        id,
        ERROR_INVALID_PARAMS,
        "Missing tool name"
      );
    }

    const toolName = params.name as string;
    const args = (params.arguments as Record<string, unknown>) || {};

    console.error(`Tool call: ${toolName} with args:`, args);

    try {
      const result = await this.toolHandler.executeTool(toolName, args);
      return buildResponse(id, result);
    } catch (e) {
      const error = e as Error;
      console.error(`Error executing tool ${toolName}:`, error);
      return buildErrorResponse(
        id,
        ERROR_INTERNAL,
        `Error: ${error.message}`
      );
    }
  }
}
