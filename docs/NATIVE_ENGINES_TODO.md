# Native engines: remaining work

**Status: COMPLETED in v0.7.0 (`b6d115a`) and v0.7.1 (`4254b36`).**
- Section 3 (`MIN_ENGINE_VERSIONS` and `REQUIRED_ENGINE_FEATURES` floor audit) is implemented in `src/versions.ts` and verified in `tests/versions.test.ts`.
- Section 4 & Section 5 (in-process `NativeAddonCormRunner` over `@tty-pt/{stele,corm,joint,lemma,sepal,islet}` prebuilds with zero simplified JS fallbacks and automatic `node_modules/@tty-pt/*/prebuilds/<os>-<cpu>[-musl]` resolution) is implemented in `src/napi_runner.ts` and `src/config.ts` and verified in `tests/npm_standalone_install.test.ts`.

*(Historical design note preserved below — written 2026-11-13, when the engines were `libcorm` 2.3.3, `libsepal` 1.4.2, `liblemma` 1.3.2, `libjoint` 1.7.3 and `libislet` 1.5.2.)*

pi-mm and pi-quest depend on native C engines (`corm`, `cormd`, and the lemma / sepal / joint axes
they load). Two things need to be fixed before this can be shared widely:

1. The minimum engine versions in `src/versions.ts` are not verified, and at least one is wrong.
2. Users have to install the C engines themselves. The engines are now published to npm as
   `@tty-pt/corm`, `@tty-pt/lemma`, `@tty-pt/sepal`, `@tty-pt/joint` and `@tty-pt/islet`, so pi-mm
   could use them directly instead of going through `cormd`.

Section 3 is the interim fix and section 4 is the larger change. They are independent.

## 1. How pi-mm depends on the engines today

- `src/versions.ts` (the same file is vendored into pi-quest) holds `MIN_ENGINE_VERSIONS`. At the
  time of writing:

  | Engine | Minimum | Latest |
  |---|---|---|
  | `libcorm` | 2.0.0 | 2.3.3 |
  | `libsepal` | 1.2.0 | 1.4.2 |
  | `liblemma` | 1.1.0 | 1.3.2 |
  | `libjoint` | 1.5.0 | 1.7.3 |
  | `axil` | 1.6.0 | not checked |
  | `axil-auren` | 1.3.0 | not checked |

  The installed versions are detected from `.pc` files, git, or the daemon. It deliberately does not
  call pkg-config.
- `src/config.ts` looks for the engines under `external/libcorm`, `external/libjoint`,
  `external/liblemma`, `external/libislet` and `external/libsepal`.
- Storage goes through a runner. `src/code/store.ts` picks
  `customRunner ?? DaemonCormRunner (when a cormd binary is found) ?? shellRunner (the corm CLI)`.
- `src/daemon.ts` sends these verbs to `cormd`: `LIST`, `GET`, `GET_JSON`, `PUT`, `PUT_JSON`, `DEL`,
  `DEL_ALL`, `QUERY`, `RECONCILE`. `src/corm.ts` runs the `corm` CLI with `-p`, `-r`, `-g`, `-X`,
  `-t` and `-d`.
- `src/lock.ts` serialises writers across processes with `flock`, and `cormd` leases the database
  ("database is leased by resident cormd; direct mutation forbidden").

## 2. What is known to be wrong, and what is not known

**Verified.** `PUT_JSON` and `GET_JSON` first appear in `libcorm` v2.2.0. This was checked by reading
`src/cormd.c` at every `v2.*` tag. `pi-mm` sends both, but the minimum is 2.0.0, so a user with
`libcorm` 2.0.x or 2.1.0 passes the version check and then gets unknown-command errors. The minimum
must be at least 2.2.0. `LIST`, `GET`, `PUT`, `DEL`, `DEL_ALL`, `QUERY` and `RECONCILE` already exist
in v2.0.0.

**Not verified** (do not assume they are correct):
- The other `libcorm` features pi-mm relies on: the lease behaviour, the CLI flags above, record
  schemas and filespecs.
- Every `libsepal`, `liblemma`, `libjoint`, `axil` and `axil-auren` minimum.
- How pi-mm uses `libsepal`, `liblemma` and `libjoint`. They are loaded as axes by corm. A check of
  the version string says nothing about which of their features are needed.

## 3. Interim fix: make the minimums correct (small)

1. Inventory what pi-mm and pi-quest call on each engine: daemon verbs, CLI flags, axis behaviour and
   `axil-auren` endpoints.
2. For each engine, find the oldest release that has everything in that list. The engines' own
   `CHANGELOG.md` files and `git show <tag>:<file>` are the source of truth. A tag's date is not.
3. Set `MIN_ENGINE_VERSIONS` to those values in both `pi-mm/src/versions.ts` and
   `pi-quest/src/versions.ts` (same file).
4. Add a test that fails when a minimum is below a recorded per-feature requirement, so a new pi-mm
   feature cannot outrun the minimums without someone noticing.

## 4. Larger change: use the npm packages in-process (no `cormd`)

**Why.** `npm install` replaces installing five native libraries, pkg-config and a daemon. The
minimums become semver ranges in `package.json`, enforced by npm, so the check in section 3 stops
being needed for these engines. `axil-auren` is a separate server and stays as it is.

**Design rule: no simplified JS reimplementations.**
The `npm/dist/index.js` wrappers currently contain simplified pure-JS `Map` fallbacks (`_memStore`,
`documents`, `_memVectors`, `_memPoints`) and duplicate toy axis classes (`LemmaLexicalAxis`,
`SepalVectorAxis`, `JointTemporalAxis`). We will **not** maintain double implementations. All
simplified JS reimplementations will be removed; the npm packages must wrap the original C libraries
directly via Node-API (`*_napi.c`), and `@tty-pt/corm` will load the real C axis shared libraries
(`libjoint`, `liblemma`, `libsepal`, `libislet`) that `~/ci/scripts/build-node-addon.sh` already
bundles inside each package's `prebuilds/<os>-<cpu>/` directory.

**Why it is not a drop-in swap today.**
- **Binding API gap.** Each package's `npm/native/*_napi.c` currently binds only a small subset of
  its C library (detailed in section 5 below), while `npm/dist/index.js` fills the rest with the
  simplified JS `Map` code that we want to delete.
- **Persistence and platform prebuilds.** On-disk `CormDb` and `JointTimeline` require native
  bindings. The npm packages currently ship native prebuilds for `linux-x64` (glibc), `darwin-arm64`,
  `darwin-x64` and `win32-x64`. Additional targets (`linux-arm64`, `linux-musl` plus a `-musl` key in
  `@tty-pt/stele`'s `loadNativeAddon`) are needed so native Node-API works across supported hosts.
- **Several sessions on one project.** `cormd` plus `lock.ts` arbitrate today. In-process use needs
  the same lease (`flock`), and each session opens/rebuilds the in-memory `lemma` index unless
  `cormd` is running.
- **Runtime.** pi-mm's tests run under Deno. Loading the Node-API `.node` addons under Deno must be
  verified.

## 5. Per-package native Node-API requirements

### 5.1 `@tty-pt/corm` (`external/libcorm`)
- **`npm/native/corm_napi.c`**:
  - Expose the `corm` / `cormd` C command and query engine in-process (`src/cormd.c` / `src/corm.c`
    verbs: `LIST`, `GET`, `GET_JSON`, `PUT`, `PUT_JSON`, `DEL`, `DEL_ALL`, `QUERY`, `RECONCILE`,
    `-X` boolean/scoring expressions, `.roster` sidecar management, and `HTOK` binary record
    conversion from `src/htok.c`).
  - Support `CM_HNDL` (`u`/`a`) integer keys, `corm_blob_type()` (`b`) binary `Uint8Array` values,
    and `CM_MIRROR` in `CormDb` (currently hardcoded to `CM_STR -> CM_STR`).
  - Bind the `cormr_axis_*` registry (`cormr_axis_register`, `cormr_axis_get`, `cormr_axis_set_ctx`,
    `cormr_query_run`) so C axis plugins work directly from Node.
- **`npm/dist/index.js`**:
  - Delete `_memStore` and the inline JS copies of `JointTemporalAxis`, `SepalVectorAxis`, and
    `LemmaLexicalAxis` (lines 320–481).
  - Resolve `CORM_AXIS_PATH` automatically from the installed `@tty-pt/{joint,lemma,sepal,islet}`
    `prebuilds/<os>-<cpu>/` directories in `node_modules` so `corm_axes_find_lib()` (`src/corm.c`)
    `dlopen`s the bundled `lib<axis>.so`/`.dylib`/`.dll` plugins without system-wide installs or
    `.pc` files.

### 5.2 `@tty-pt/lemma` (`external/liblemma`)
- **`npm/native/lemma_napi.c`**:
  - Currently binds only `lemma_fold`. Add N-API bindings for the real C engine (`src/liblemma.c`,
    `src/tok.c`):
    - `lemma_tokenize`
    - `lemma_open`, `lemma_close` (including primary DB rebuild on open via `rec_axis_open`)
    - `lemma_index_ref`, `lemma_unindex_ref` (`rec_axis_unstore`), `rec_axis_store_typed` (`HTOK`
      binary payload indexing)
    - `lemma_fill`, `lemma_rank` (real C BM25 + `--field`, `--query`, `--phrase`, `--matched`
      scoring)
    - `lemma_tok_encode`, `lemma_tok_decode` (16-bit vocabulary codec used by `HTOK`)
- **`npm/dist/index.js`**:
  - Delete the pure-JS `this.documents = new Map()` in `LemmaIndex` and the naive token-ratio loop
    (lines 60–111); back `LemmaIndex` and `LemmaLexicalAxis` strictly with the `lemma_napi.c` C
    handle.

### 5.3 `@tty-pt/sepal` (`external/libsepal`)
- **`npm/native/sepal_napi.c`**:
  - Add the missing C functions from `src/libsepal.c`:
    - `sepal_close`
    - `sepal_del` (`rec_axis_unstore`)
    - `sepal_get` / `sepal_dim` (`rec_axis_readback`)
    - `sepal_sketch` and `sepal_hamming` (currently only bound in WASM, missing from N-API)
    - `sepal_fill`, `sepal_rank`, `rec_axis_store_typed`, and `rec_axis_config_arg` /
      `rec_axis_env_config` (`CORM_SEPAL_EMBED_*`)
  - Accept `Float32Array` zero-copy via `napi_get_typedarray_info` in `SepalPut` and `SepalSearch`
    instead of per-element `napi_get_element` loops.
- **`npm/dist/index.js`**:
  - Delete `this._memVectors = new Map()` and the JS cosine-search loop in `VectorIndex` and
    `SepalVectorAxis` (lines 195–275); forward all operations to the C `sepal_vecstore_t` handle.

### 5.4 `@tty-pt/joint` (`external/libjoint`)
- **`npm/native/joint_napi.c`**:
  - Expose the full C interval engine from `src/libjoint.c`:
    - Separate `joint_start(jd, ts, ref)` and `joint_stop(jd, ts, ref)` (or allow open-ended
      `[ts, +∞)` intervals in `record` instead of forcing `end_ts = start_ts + 1` at
      `joint_napi.c:89`)
    - `joint_erase(jd, ref)` (`rec_axis_unstore`)
    - `joint_fill` / `rec_axis_store` / `rec_axis_store_typed` (including ISO date parsing for
      `--since`/`--until` and `HTOK` timestamp extraction)
- **`npm/dist/index.js`**:
  - Keep `JointTimeline` and `JointTemporalAxis` backed strictly by the `joint_napi.c` `joint_d`
    handle.

### 5.5 `@tty-pt/islet` (`external/libislet`)
- **`npm/native/islet_napi.c`**:
  - Bind the missing C functions from `src/libislet.c` and `include/ttypt/islet.h`:
    - `encode3D` (`islet_encode_3`) and `decode3D` (`islet_decode_3`)
    - `searchBox` wrapping `islet_iter_2` + `islet_next` (which runs Tropf–Herzog
      `islet_jump_over_gap` Z-order pruning in C)
    - `close` (`corm_save` + `corm_close`)
    - `del` / `rec_axis_store` / `rec_axis_unstore` (multi-ref grid cell storage + reverse index
      cleanup)
- **`npm/dist/index.js`**:
  - Delete `this._memPoints = new Map()` and the JS brute-force `searchBox` loop (lines 425–465).
  - Wire `SpatialIndex.searchBox()` and `SpatialIndex.close()` to `nativeBinding.searchBox` and
    `nativeBinding.close` (both currently missing in native mode), and export `IsletSpatialAxis`
    backed by C to match `dist/index.d.ts`.

## 6. Execution plan & completion criteria

**Plan.**
1. Do the inventory from section 3 step 1. It defines the exact surface used by `pi-mm` and
   `pi-quest`.
2. Upgrade `*_napi.c` and strip the simplified JS reimplementations from `npm/dist/index.js` across
   `libislet`, `libjoint`, `liblemma`, `libsepal`, and `libcorm` (section 5).
3. Add an in-process runner next to `DaemonCormRunner` and `shellRunner` in `src/code/store.ts`, with
   the lease from `src/lock.ts` around it and automatic `CORM_AXIS_PATH` discovery from
   `node_modules/@tty-pt/*/prebuilds/<key>`.
4. Add prebuilds for `linux-arm64` and `linux-musl` (and add `-musl` detection to `@tty-pt/stele`'s
   `loadNativeAddon`).
5. Keep `cormd` and the `corm` CLI as optional accelerators, with their own (corrected) minimums.

**Done when.**
- Every package's `npm/dist/index.js` delegates to its C library via Node-API with zero duplicate JS
  indexing/search implementations.
- `pi-mm`'s test suite passes with only `npm install` done (no host `corm`, `cormd`, `/usr/lib/lib*.so`
  or `.pc` files) on `linux-x64`, `darwin-arm64`, `darwin-x64`, and `win32-x64`.
- A database written by `cormd` is read identically by the in-process Node-API runner and vice versa.
- Two sessions on the same project do not corrupt the database.

## 7. Related

- The npm packaging and per-platform prebuild pipeline (what produces `prebuilds/<os>-<cpu>/`) lives
  in `tty-pt/ci` (`scripts/build-node-addon.sh`, `.github/workflows/all-in-one.yml`).
- Intermittent `ssh` exit 255 failures in the `publish` jobs are a separate CI problem. See
  `PLAN-publish-traffic-and-locks.md` in `tty-pt/ci`.
