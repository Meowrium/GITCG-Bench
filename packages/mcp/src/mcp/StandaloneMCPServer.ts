import { BaseMcpServer } from "./BaseMcpServer";
import { StandaloneMcpToolHandler } from "./StandaloneMcpToolHandler";
import type { StandaloneMcpClient } from "../StandaloneMcpClient";

const SERVER_NAME = "MCPGTCG-Standalone";
const SERVER_VERSION = "1.0.0";

export interface StandaloneMCPServerOptions {
  who?: 0 | 1;
  toolExposureMode?: "direct-action" | "fragmented-decision";
  /** Inject a pre-built client for headless/in-memory mode */
  client?: StandaloneMcpClient;
}

export class StandaloneMCPServer extends BaseMcpServer<StandaloneMcpToolHandler> {
  private baseUrl: string;

  constructor(
    baseUrl: string = "http://localhost:3901",
    whoOrOptions: 0 | 1 | StandaloneMCPServerOptions = 0,
    toolExposureMode: "direct-action" | "fragmented-decision" = "direct-action",
  ) {
    // Normalize overloaded constructor: (baseUrl, who, mode) | (baseUrl, options)
    const options: StandaloneMCPServerOptions = typeof whoOrOptions === "number"
      ? { who: whoOrOptions, toolExposureMode }
      : whoOrOptions;
    super(
      new StandaloneMcpToolHandler(baseUrl, options),
      { serverName: SERVER_NAME, serverVersion: SERVER_VERSION },
    );
    this.baseUrl = baseUrl;
  }

  protected onStart(): void {
    console.error(`Connecting to standalone at: ${this.baseUrl}`);

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

  protected onSessionInitialized(sessionId: string): void {
    this.toolHandler.setSessionId(sessionId);
  }
}
