import { app } from 'electron';

// @@@headless-electron - every real-Electron test fixture is a process without UI activation. Declare it before
// ready: a regular app activating at launch asks AppKit for ViewBridgeAuxiliary, a per-user XPC service that only
// stays up in a GUI login session. Without one (CI runner accounts) it exits at once and launchd throttles its
// respawn for 10 s, so a launch that asks inside that window waits ~10 s before ready. A prohibited app never asks.
if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
