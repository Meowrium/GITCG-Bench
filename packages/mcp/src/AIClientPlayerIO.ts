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
  CancellablePlayerIO,
  Notification,
  RpcRequest,
  RpcResponse,
} from "@gi-tcg/core";
import type { RpcMethod } from "@gi-tcg/typings";

interface PendingRpc {
  request: RpcRequest;
  method: RpcMethod;
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
}

export class AIClientPlayerIO implements CancellablePlayerIO {
  private notifications: Notification[] = [];
  private pendingRpc: PendingRpc | null = null;
  private rpcCancelled = false;
  private latestNotification: Notification | null = null;

  setDefaultResponseTimeout(_ms: number): void {
    // Timeout mechanism disabled - waiting for AI decision
  }

  notify(notification: Notification): void {
    console.log(`[MCP AI IO] Notification received`);
    this.notifications.push(notification);
    this.latestNotification = notification;
  }

  async rpc(request: RpcRequest): Promise<RpcResponse> {
    if (this.rpcCancelled) {
      this.rpcCancelled = false;
      throw new Error("RPC cancelled");
    }

    const method = request.request?.$case as RpcMethod;
    console.log(`[MCP AI IO] Waiting for AI decision: ${method}...`);

    return new Promise((resolve, reject) => {
      this.pendingRpc = {
        request,
        method,
        resolve,
        reject,
      };
    });
  }

  cancelRpc(): void {
    if (this.pendingRpc) {
      this.rpcCancelled = true;
      this.pendingRpc.reject(new Error("RPC cancelled"));
      this.pendingRpc = null;
    }
  }

  getNotifications(): Notification[] {
    return [...this.notifications];
  }

  getLatestNotification(): Notification | null {
    return this.latestNotification;
  }

  clearNotifications(): void {
    this.notifications = [];
  }

  getPendingRpc(): PendingRpc | null {
    return this.pendingRpc;
  }

  getPendingMethod(): RpcMethod | null {
    return this.pendingRpc?.method ?? null;
  }

  respondToRpc(response: RpcResponse): boolean {
    if (this.pendingRpc) {
      this.pendingRpc.resolve(response);
      this.pendingRpc = null;
      return true;
    }
    return false;
  }

  hasPendingRpc(): boolean {
    return this.pendingRpc !== null;
  }
}
