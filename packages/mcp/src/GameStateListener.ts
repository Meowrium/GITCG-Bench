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

import type { GameState, Mutation } from "@gi-tcg/core";

export class GameStateListener {
  private static instance: GameStateListener;
  private readyForCommand = false;
  private lastState: GameState | null = null;
  private lastMutations: Mutation[] = [];
  private commandExecuted = false;

  private constructor() {}

  static getInstance(): GameStateListener {
    if (!GameStateListener.instance) {
      GameStateListener.instance = new GameStateListener();
    }
    return GameStateListener.instance;
  }

  onPause(state: GameState, mutations: Mutation[], canResume: boolean): void {
    this.lastState = state;
    this.lastMutations = mutations;
    this.readyForCommand = canResume;
    this.commandExecuted = false;
  }

  isWaitingForCommand(): boolean {
    return this.readyForCommand;
  }

  getLastState(): GameState | null {
    return this.lastState;
  }

  getLastMutations(): Mutation[] {
    return [...this.lastMutations];
  }

  registerCommandExecution(): void {
    this.commandExecuted = true;
    this.readyForCommand = false;
  }

  hasCommandExecuted(): boolean {
    return this.commandExecuted;
  }

  reset(): void {
    this.readyForCommand = false;
    this.lastState = null;
    this.lastMutations = [];
    this.commandExecuted = false;
  }
}
