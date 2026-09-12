// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Internal re-export of @gi-tcg/core types that aren't in the public API
 * but whose shape we depend on via Game.availableActions().
 */

import type { Game } from "@gi-tcg/core";

/**
 * The return type of Game.availableActions() — ActionInfoWithModification[]
 * We can't import the type directly since it's not exported from @gi-tcg/core,
 * so we infer it from the return type.
 */
export type ActionInfoWithModification = Awaited<
  ReturnType<Game["availableActions"]>
>[number];
