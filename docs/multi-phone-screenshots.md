# Multi-phone screenshot contract

## Usage

Existing callers keep one default phone:

```js
build_and_screenshot({ project: 'rotation-game' })
read_screenshot({ runId, name: 'today-clean' })
```

Responsive review requests an ordered phone list. Presets express layout intent and exact selectors reproduce a model-specific issue.

```js
build_and_screenshot({ project: 'rotation-game', phones: ['compact', 'large'] })
build_and_screenshot({
  project: 'rotation-game',
  phones: [{ key: 'support-case', model: 'iPhone 15 Pro', runtime: '18.4' }],
})

read_screenshot({ runId, phone: 'compact', name: 'today-clean' })
```

`list_screenshots` groups states by phone key. It reports the requested selector, resolved simulator model and runtime, and each PNG's measured pixel dimensions. Name-only reads remain valid when a run has one phone and fail with available phone keys when a run has several.

## Shape

```ts
type PhonePreset = 'default' | 'compact' | 'standard' | 'large';
type PhoneInput = PhonePreset | { key: string; model: string; runtime?: string };

type ScreenshotPhone = {
  key: string;
  ordinal: number;
  requested: { kind: 'preset'; preset: PhonePreset }
    | { kind: 'exact'; model: string; runtime?: string };
  resolved: null | { model: string; runtime: string };
  images: Array<{
    artifactId: string;
    name: string;
    ordinal: number;
    widthPixels: number | null;
    heightPixels: number | null;
    sizeBytes: number;
    sha256: string;
  }>;
};
```

The server normalizes and persists the ordered request when it creates a run. Omitted phones become `['default']`. It rejects empty lists, duplicate keys, more than four phones, and phone input on a run that did not request screenshots.

The runner resolves every request against one `simctl` catalogue before booting a simulator. Presets use a private ranked model registry with aspect-family boundaries. Exact selectors match the model and optional major/minor runtime without substitution. The runner drives the same app-owned journey sequentially in isolated per-phone directories and writes one version 2 manifest. Every phone must produce the same ordered state list. Any failure leaves the set unavailable.

The manifest and database use `(run, phone key, state name)` as screenshot identity. They retain requested and resolved phone facts separately. Pixel dimensions come from each PNG's IHDR because a journey may rotate between states.

One Actions artifact remains the ingestion unit. The server validates the complete phone-by-state matrix, paths, PNG signatures, dimensions, byte counts, and hashes before one transaction publishes the result. Version 1 manifests remain valid only for a legacy single-`default` request.

## Module map

- `server/src/screenshot-phones.js` normalizes public requests.
- `test-runner/scripts/resolve_ios_simulators.py` resolves requests against installed simulators.
- `test-runner/scripts/finalize_screenshots.py` creates the aggregate version 2 manifest.
- `server/src/screenshots.js` validates version 1 and version 2 bundles.
- `server/src/runs.js` persists phone requests and returns grouped summaries.
- `mcp/src/screenshots.js` selects by artifact ID or phone and state.

## Synthesis decision

Candidate A is the base because it keeps public keys, requested selectors, resolved devices, and per-image facts distinct. Candidate C contributed strict aspect-family separation and the version 1 compatibility rule. Candidate B contributed concise MCP ambiguity errors. Exact selectors use structured objects instead of encoded strings. Capture stays sequential and all-or-nothing so `ready` always means the full requested matrix exists.

## Tradeoffs accepted

- We accept a private preset registry so callers do not depend on one GitHub runner image.
- We accept sequential drives so one job produces one atomic artifact.
- We accept exact-selector failures when a requested simulator is absent instead of silently changing the reproduction target.
- We accept nullable device facts on historical screenshots instead of inventing metadata.

## Alternatives considered

- Exact models only would make ordinary callers track Xcode image churn.
- Presets only would prevent model-specific reproduction.
- A workflow matrix would need a second merge protocol before atomic ingestion.
- Encoding phones into app-owned state names would mix runner identity into the app contract.

## Open risks

- Preset candidate lists need fixture tests so Xcode updates fail with an actionable inventory rather than drifting to another aspect family.
- Four large Flutter drives may approach the workflow timeout; the first live proof uses two phones and records elapsed time.

## Next implementation step

Build and test request normalization and simulator resolution before changing persistence or the workflow.
