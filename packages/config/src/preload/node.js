// Copyright (C) 2026 Piovium Labs
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

// tsx/esbuild generates __name helper for class name inference.
// Polyfill it before tsx registration to fix "TypeError: __name is not a function".
globalThis.__name = (fn, name) => { Object.defineProperty(fn, 'name', { value: name }); return fn; };
globalThis.__esm = (fn, mod) => () => (fn(mod), mod.exports);

import "tsx";
