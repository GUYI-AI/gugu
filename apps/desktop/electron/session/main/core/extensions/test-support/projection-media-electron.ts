import '../../test-support/headless-electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, nativeImage } from 'electron';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import type { BridgeCaller } from '../extension-bridge';
import { extensionProjections as bridge } from '../extension-projection-bridge';
import { extensionsService } from '../extensions-root';
import { revokeExtensionProgramAccess } from '../extension-program-access';
import { createProjectionImageDecoder } from '../projection-image';
import { probeFeedOwnership } from './projection-feed-ownership';
import { probeDeviceProjection } from './projection-device-electron';
import { projectionSources, type ProjectionHost } from '../../../../../../src/session/app-runtime/projection-source';
import { openMediaProcess } from '../../../../../../native/projection-media/node/host.mjs';
import { ProjectionSignals } from '../../../../../../native/projection-media/node/signaling.mjs';
import { withFixtureCleanup } from '../../test-support/fixture-failure';

if (!process.env.GUGU_HOME || !process.env.GUGU_USER_DATA_DIR) throw new Error('Pipeline fixture needs isolated paths');
app.setPath('userData', process.env.GUGU_USER_DATA_DIR);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Diagnostic-only: bounded phase names and monotonic offsets, never payloads or identities.
const diagnosticPhases = new Set<string>(["answer-applied", "answer-received", "browser-closed", "browser-spawn-called", "browser-spawned", "cleanup-entered", "first-wait-complete", "first-wait-entered", "frame-encoded", "http-module", "http-offer", "http-viewer", "input-driver-applied", "input-driver-entered", "input-result-received", "paint-one-received", "pixels-decoded", "viewer-answer-accepted", "viewer-answer-start", "viewer-channel-ready", "viewer-closed", "viewer-closed-error", "viewer-error", "viewer-frame-matched", "viewer-generation-received", "viewer-input-result", "viewer-script-started", "viewer-video-frame", "wait-timeout"]);
const diagnosticSeen = new Set<string>();
const diagnosticStart = performance.now();
function mark(phase: string, rendererElapsedMs?: number): void {
  if (!diagnosticPhases.has(phase) || diagnosticSeen.has(phase)) return;
  diagnosticSeen.add(phase);
  process.stderr.write('REAL_ELECTRON_FIXTURE_PHASE=' + JSON.stringify({ phase,
    elapsedMs: performance.now() - diagnosticStart,
    ...(rendererElapsedMs === undefined ? {} : { rendererElapsedMs }) }) + '\n');
}

void app.whenReady().then(async () => {
  const id = 'projection-media-native-fixture', service = extensionsService();
  const bundle = path.join(app.getPath('userData'), 'fixture-app');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'index.html'), '<body>Fixture App</body>');
  fs.writeFileSync(path.join(bundle, 'fixture.mjs'), 'process.stdin.resume();');
  fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
    platforms: ['desktop'], entry: 'index.html', permissions: { capabilities: ['agents:tools'], network: [] },
    contributes: { instructions: 'Projection fixture tools.', tabs: [{ name: 'main', title: 'Fixture' }], mcpServers: [{ name: 'fixture', command: 'node', args: ['fixture.mjs'] }] },
  }));
  service.installFromDirectory(bundle, service.inspectDirectory(bundle).manifestDigest, 'folder');
  const source = new BrowserWindow({ show: false, frame: false, useContentSize: true, width: 128, height: 96,
    webPreferences: { backgroundThrottling: false } });
  const appPage = new BrowserWindow({ show: false });
  let hear: Parameters<NonNullable<ProjectionHost['onProjectionSource']>>[0] = () => {};
  const program = { kind: 'program', extensionId: id, pageId: -91, callingSession: 'fixture-task', binding: null,
    hear: (event: { type: string; event: Parameters<typeof hear>[0] }) => { if (event.type === 'projectionSource') hear(event.event); },
  } as unknown as BridgeCaller;
  const call = (verb: string, args: Record<string, unknown>) => bridge.call(program, verb, args);
  const runtime = projectionSources({ projection: {
    create: args => call('projectionCreate', args) as Promise<{ id: string }>,
    publish: args => call('projectionPublish', args) as Promise<void>, close: args => call('projectionClose', args) as Promise<void>,
    closed: args => call('projectionClosed', args) as Promise<void>, inputResult: args => call('projectionInputResult', args) as Promise<void>,
    watch: async () => {}, unwatch: async () => {}, send: async () => {},
  }, onProjectionSource: callback => { hear = callback; return () => {}; } });
  const page = { kind: 'page', extensionId: id, pageId: appPage.webContents.id, binding: { workspace: 'session:fixture-task' } } as BridgeCaller;
  const context = { ownerId: 'fixture-owner', deviceId: 'fixture-viewer', appId: id, sessionId: 'fixture-task', pageId: String(page.pageId), epoch: '0' };
  let fault: unknown, inputCalls = 0, stopped = false;
  const paints: Array<{ sequence: number; rtpTimestamp: number; rgb: number[] }> = [];
  const outcomes: unknown[] = [], pixels: Uint8Array[] = [];
  const decoded: number[][] = [];
  let disconnected = 0, viewerGeneration = "";
  const encoded = new Map<number, number>();
  await source.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:rgb(26,96,190)"><textarea style="width:60px;height:20px"></textarea><script>document.querySelector("textarea").focus()</script>'));
  const publisher = await runtime.create({
    input: async (input, { signal }) => { signal.throwIfAborted(); assert.equal(input.kind, 'text');
      if (input.kind === 'text') { mark('input-driver-entered'); inputCalls++; await source.webContents.insertText(input.text); mark('input-driver-applied'); } },
    disconnect: async () => { disconnected++; }, close: () => { stopped = true; },
    refresh: async () => { await capture(); },
  });
  async function capture() {
    const picture = await source.webContents.capturePage();
    assert.deepEqual(picture.getSize(), { width: 128, height: 96 });
    return publisher.publish({ width: 128, height: 96, mime: 'image/png', data: picture.toPNG().toString('base64') });
  }
  const feeds = new Map<unknown, ReturnType<typeof bridge.mediaFeed>>();
  const signals = new ProjectionSignals({
    authorize: async (bound, sourceId, signal) => {
      signal.throwIfAborted();
      const feed = bridge.mediaFeed(page, sourceId, bound, () => {
        const decode = createProjectionImageDecoder(nativeImage.createFromBuffer, { r: 0, g: 0, b: 0 });
        return async (frame, signal) => {
          const lease = await decode(frame, signal); mark('pixels-decoded'); pixels.push(lease.data);
          const at = (80 * frame.width + 110) * 4; decoded.push([...lease.data.subarray(at, at + 4)]); return lease;
        };
      }, async (size, signal, onControl) => {
        const media = await openMediaProcess({ ...size, executable: process.env.GUGU_TEST_MEDIA_HELPER!,
          ffmpeg: process.env.GUGU_PROJECTION_FFMPEG!, fps: 10, bitrate: 500000, signal,
          onControl: raw => { const packet = JSON.parse(raw); if (packet.type === 'ack') viewerGeneration ||= packet.generation; onControl(raw); } });
        return { ...media, async publish(sequence, data) { const receipt = await media.publish(sequence, data); mark('frame-encoded');
          encoded.set(sequence, receipt.rtpTimestamp); return receipt; } };
      });
      feeds.set(feed.lease, feed); return feed.lease;
    },
    openMedia: (lease, signal, onControl) => feeds.get(lease)!.openMedia(signal, onControl),
  });
  let server: ReturnType<typeof createServer> | undefined, browser: ReturnType<typeof spawn> | undefined;
  let browserExit = Promise.resolve(), exited = false;
  let phase = 'setup';
  await withFixtureCleanup(() => phase, async () => {
    const opened = await signals.receive(context, { type: 'open', requestId: 'fixture-open', sourceId: publisher.id }) as { id: string; offer: { type: 'offer'; sdp: string } };
    assert.ok(opened?.offer);
    server = createServer(async (request, response) => {
      try {
        if (request.url === '/viewer.mjs') { mark('http-module'); response.setHeader('Content-Type', 'text/javascript'); response.end(fs.readFileSync(path.join(process.cwd(), 'apps/desktop/native/projection-media/web/viewer.mjs'))); return; }
        if (request.url === '/offer') { mark('http-offer'); response.end(JSON.stringify(opened.offer)); return; }
        if (request.method !== 'POST') { if (request.url === '/') mark('http-viewer'); response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
        let data = '';
        for await (const chunk of request) { data += chunk; if (data.length > 128 * 1024) throw new Error('Fixture message too large'); }
        if (request.url === '/fixture-phase') {
          try {
            const value = JSON.parse(data);
            if (typeof value?.phase === 'string' && value.phase.startsWith('viewer-')
              && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0) mark(value.phase, value.elapsedMs);
          } catch { /* A diagnostic packet must not become the pipeline's fault. */ }
        } else if (request.url === '/answer') {
          mark('answer-received'); await signals.receive(context, { type: 'answer', id: opened.id, sdp: JSON.parse(data) }); mark('answer-applied');
        } else if (request.url === '/paint') {
          paints.push(JSON.parse(data)); if (paints.at(-1)?.sequence === 1) mark('paint-one-received');
        } else if (request.url === '/result') { outcomes.push(JSON.parse(data)); mark('input-result-received'); }
        else if (request.url === '/error') throw new Error(data);
        response.end('{}');
      } catch (error) { fault = error; response.statusCode = 400; response.end(String(error)); }
    });
    const listening = server;
    await new Promise<void>(resolve => listening.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    mark('browser-spawn-called');
    browser = spawn(process.env.GUGU_TEST_CHROMIUM!, ['--headless=new', '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage', `--user-data-dir=${path.join(app.getPath('userData'), 'headless-viewer')}`, `http://127.0.0.1:${address.port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    browser.once('spawn', () => mark('browser-spawned'));
    let stderr = '';
    browser.stderr?.on('data', data => { stderr = (stderr + data).slice(-4096); });
    const chromium = browser;
    browserExit = new Promise<void>(resolve => { chromium.once('error', error => { fault = error; }); chromium.once('close', () => { mark('browser-closed'); exited = true; resolve(); }); });
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 12000;
      while (!condition()) { if (fault) throw fault; if (exited) throw new Error('Chromium exited: ' + stderr);
        if (Date.now() > deadline) { mark('wait-timeout'); throw new Error('Pipeline timed out: ' + stderr); } await pause(20); }
    };
    phase = 'first-paint'; mark('first-wait-entered');
    await until(() => paints.some(paint => paint.sequence === 1) && outcomes.length > 0);
    mark('first-wait-complete');
    const first = paints.find(paint => paint.sequence === 1)!;
    for (const [channel, wanted] of [26, 96, 190].entries()) assert.ok(Math.abs(first.rgb[channel]! - wanted) < 12, JSON.stringify(first));
    assert.equal(first.rtpTimestamp, encoded.get(1));
    assert.ok(viewerGeneration);
    assert.deepEqual(outcomes[0], { type: 'input-result', generation: viewerGeneration, sequence: 1, status: 'applied' });
    assert.equal(inputCalls, 1);
    assert.equal(await source.webContents.executeJavaScript('document.querySelector("textarea").value'), '整链中文🙂');
    // JS completion can precede compositor capture; witness the new paint first.
    await source.webContents.executeJavaScript('document.body.style.background="rgb(190,40,26)"; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await capture(), 2);
    phase = 'second-paint';
    await until(() => paints.some(paint => paint.sequence === 2));
    const second = paints.find(paint => paint.sequence === 2)!;
    for (const [channel, wanted] of [190, 40, 26].entries()) assert.ok(Math.abs(second.rgb[channel]! - wanted) < 12, JSON.stringify({ second, decoded }));
    assert.equal(second.rtpTimestamp, encoded.get(2));
    assert.equal(pixels.length, 2); assert.equal(pixels[0], pixels[1]);
    const ownershipPicture = await source.webContents.capturePage();
    const ownership = await probeFeedOwnership(runtime, page, context,
      { width: 128, height: 96, mime: 'image/png', data: ownershipPicture.toPNG().toString('base64') },
      () => openMediaProcess({ executable: process.env.GUGU_TEST_MEDIA_HELPER!, ffmpeg: process.env.GUGU_PROJECTION_FFMPEG!,
        width: 128, height: 96, fps: 10, bitrate: 500000, signal: new AbortController().signal }));
    phase = 'device-projection';
    const device = await probeDeviceProjection(id);
    service.setPermissionGranted(id, 'agents:tools', false);
    await assert.rejects(publisher.publish({ width: 128, height: 96, mime: 'image/png', data: 'YQ==' }), /revoked/);
    revokeExtensionProgramAccess(id);
    phase = 'revocation-drain';
    await until(() => stopped && [...feeds.values()][0]!.lease.signal.aborted);
    await signals.dispose();
    assert.ok(disconnected > 0); assert.equal(inputCalls, 1);
    process.stdout.write('PROJECTION_PIPELINE_RESULT=' + JSON.stringify({ passed: true, ownership, device, paints, decoded, inputCalls, reused: pixels[0] === pixels[1],
      home: process.env.GUGU_HOME, userData: app.getPath('userData'), electron: process.versions.electron }) + '\n');
  }, async () => {
    mark('cleanup-entered');
    try { await signals.dispose(); }
    finally {
      if (!exited) browser?.kill('SIGTERM'); await browserExit;
      if (server) { server.closeAllConnections(); const currentServer = server;
        await new Promise<void>(resolve => currentServer.close(() => resolve())); }
      bridge.closePage(page.pageId); bridge.closePage(program.pageId); source.destroy(); appPage.destroy();
    }
  });
  app.quit();
}).catch(error => { process.stderr.write(String(error) + '\n'); app.exit(1); });

const html = `<!doctype html><meta charset="utf-8"><video autoplay muted playsinline></video><canvas width="128" height="96"></canvas><script type="module">
import {openProjectionVideo} from '/viewer.mjs';
const phaseStart=performance.now(), phaseSeen=new Set();
const trace=phase=>{if(phaseSeen.has(phase))return;phaseSeen.add(phase);
 void fetch('/fixture-phase',{method:'POST',body:JSON.stringify({phase,elapsedMs:performance.now()-phaseStart})}).catch(()=>{});};
(async()=>{
 trace('viewer-script-started');
 let generation, sent=false;
 const video=document.querySelector('video'), ctx=document.querySelector('canvas').getContext('2d');
 if(typeof video?.requestVideoFrameCallback==='function')video.requestVideoFrameCallback(()=>trace('viewer-video-frame'));
 const viewer=await openProjectionVideo({video,offer:await(await fetch('/offer')).json(),
 answer:async sdp=>{trace('viewer-answer-start');const response=await fetch('/answer',{method:'POST',body:JSON.stringify(sdp)});if(!response.ok)throw new Error(await response.text());trace('viewer-answer-accepted')},
 onControl:raw=>{const value=JSON.parse(raw);if(value.type==='projection-generation'){generation=value.generation;trace('viewer-generation-received');}
 else if(value.type==='input-result'){trace('viewer-input-result');void fetch('/result',{method:'POST',body:raw})}},
 onFrame:(frame,send)=>{if(!frame||!generation)return;trace('viewer-frame-matched');ctx.drawImage(video,0,0,128,96);const p=ctx.getImageData(110,80,1,1).data;
 send(JSON.stringify({type:'ack',generation,frame:frame.sequence}));
 void fetch('/paint',{method:'POST',body:JSON.stringify({...frame,rgb:[p[0],p[1],p[2]]})});
 if(!sent){sent=true;send(JSON.stringify({type:'input',generation,frame:frame.sequence,sequence:1,input:{kind:'text',text:'整链中文🙂'}}))}}
 });trace('viewer-channel-ready');
 void viewer.closed.then(()=>trace('viewer-closed'),()=>trace('viewer-closed-error'));
})().catch(error=>{trace('viewer-error');return fetch('/error',{method:'POST',body:String(error)})});
</script>`;
