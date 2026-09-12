import type {
  JsonRpcRequest,
  ToolDefinition,
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

export interface ToolHandlerInterface {
  getToolDefinitions(): ToolDefinition[];
  executeTool(toolName: string, args: Record<string, unknown>): Promise<any>;
}

export interface BaseMcpServerOptions {
  serverName: string;
  serverVersion: string;
}

export abstract class BaseMcpServer<THandler extends ToolHandlerInterface> {
  protected toolHandler: THandler;
  protected serverName: string;
  protected serverVersion: string;
  protected initialized = false;
  protected running = false;
  protected sessionId: string | null = null;

  constructor(handler: THandler, options: BaseMcpServerOptions) {
    this.toolHandler = handler;
    this.serverName = options.serverName;
    this.serverVersion = options.serverVersion;
  }

  getToolHandler(): THandler {
    return this.toolHandler;
  }

  async start(): Promise<void> {
    this.running = true;
    console.error(`MCP Server ${this.serverName} v${this.serverVersion} started`);
    this.onStart();
  }

  stop(): void {
    this.running = false;
    console.error("MCP Server stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  protected abstract onStart(): void;

  protected abstract onSessionInitialized(sessionId: string): void;

  protected handleInput(input: string): void {
    try {
      const lines = input.split("\n").filter((line) => line.trim() !== "");
      for (const line of lines) {
        this.handleMessage(line);
      }
    } catch (e) {
      console.error("Error handling input:", e);
    }
  }

  protected handleMessage(message: string): void {
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

  protected async handleMethodAsync(
    method: string,
    id: string | number,
    params: Record<string, unknown> | undefined
  ): Promise<void> {
    let response: string;
    switch (method) {
      case METHOD_INITIALIZE:
        response = this.handleInitialize(id);
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

  protected sendResponse(response: string): void {
    console.log(response);
  }

  private handleInitialize(id: string | number): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      this.sessionId = crypto.randomUUID();
    } else {
      this.sessionId = "sess_" + Math.random().toString(36).substring(2, 15) +
                      Math.random().toString(36).substring(2, 15);
    }
    this.initialized = true;
    this.onSessionInitialized(this.sessionId!);
    console.error(`MCP initialized, session: ${this.sessionId}`);
    const result = buildInitializeResult(this.serverName, this.serverVersion);
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
