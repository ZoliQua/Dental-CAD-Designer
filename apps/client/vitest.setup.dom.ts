// apps/client/vitest.setup.dom.ts
//
// Setup for the `client-dom` (browser-mode) Vitest project — see
// apps/client/vitest.config.ts and apps/client/src/ui/README.md.
//
// React 18's `act()` environment auto-detection looks for
// `globalThis.IS_REACT_ACT_ENVIRONMENT` — @testing-library/react (and its
// own jsdom-project auto-configuration) normally sets this for you, but
// only via a code path keyed off detecting a jsdom-like global `document`
// at import time. Vitest's browser-mode runner provides a REAL browser
// `document` (not jsdom), which that auto-detection doesn't recognize, so
// without this the console fills with "The current testing environment is
// not configured to support act(...)" warnings on every state update caused
// by a user-event interaction (harmless to test correctness, since
// @testing-library/react's `render`/`fireEvent` still wrap updates in `act`
// internally — just noisy). Setting this explicitly is the documented fix
// for any non-jsdom DOM test environment.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
