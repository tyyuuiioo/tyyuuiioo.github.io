/**
 * Payload dispatch test harness.
 *
 * Runs the REAL includes/payloads/payloads.js + payloadsList.js +
 * payloadsHandler.js dispatch path inside a Node VM with a fake PS4 browser,
 * then reports for every UI payload card what would actually happen.
 *
 * Two independent failure domains are simulated, because on a real PS4 they
 * are different servers:
 *
 *   payLoader : GoldHEN's PayLoader on http://<ps4>:9090  (may be down/busy)
 *   fileMode  : the payload file served by THIS site   (may be empty/missing)
 *
 * Run:  node tests/payload-dispatch.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------------------------------------------------------------- mock XHR
function makeXHRClass(env) {
  return class MockXHR {
    constructor() {
      this.readyState = 0; this.status = 0; this.response = null;
      this.responseText = ''; this.responseType = '';
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    send() {
      const isPayLoader = /:9090(\/|$)/.test(this.url);
      const isPayloadFile = /\.(bin|elf)(\?|$)/.test(this.url);
      setTimeout(() => {
        if (isPayLoader) {
          env.payLoaderTouched = true;
          if (env.payLoader === 'error') return this.onerror && this.onerror(new Error('ECONNREFUSED'));
          this.status = 200;
          if (/\/status$/.test(this.url)) {
            this.responseText = JSON.stringify({ status: env.payLoader });
          } else {
            this.response = env.payloadBytes;
            env.posted.push(this.url);
          }
          return this.onload && this.onload({});
        }
        if (isPayloadFile) {
          env.fetched.push(this.url);
          if (env.fileMode === 'error') return this.onerror && this.onerror(new Error('ENOENT'));
          this.status = env.fileMode === 'missing' ? 404 : 200;
          this.response = env.fileMode === 'empty' ? new ArrayBuffer(0) : env.payloadBytes;
          return this.onload && this.onload({});
        }
        // anything else (status probe on localhost, etc.)
        this.status = 200; this.response = env.payloadBytes;
        return this.onload && this.onload({});
      }, 0);
    }
  };
}

// ---------------------------------------------------------------- sandbox
function buildEnv(opts) {
  const o = opts || {};
  const env = {
    payLoader: o.payLoader || 'error',
    fileMode: o.fileMode || 'ok',
    payloadBytes: o.payloadBytes || new ArrayBuffer(64),
    https: o.https === true,
    fetched: [], posted: [], alerts: [], confirms: [], logs: [],
    jailbreakCalls: 0, payLoaderTouched: false,
  };

  const store = () => {
    const m = {};
    return {
      getItem: (k) => (k in m ? m[k] : null),
      setItem: (k, v) => { m[k] = String(v); },
      removeItem: (k) => { delete m[k]; },
    };
  };

  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = { log() {}, error() {}, warn() {}, info() {} };
  sandbox.setTimeout = (fn) => setTimeout(fn, 0);
  sandbox.setInterval = () => 0;
  sandbox.clearInterval = () => {};
  sandbox.sleep = () => Promise.resolve();
  sandbox.localStorage = store();
  sandbox.sessionStorage = store();
  sandbox.XMLHttpRequest = makeXHRClass(env);
  sandbox.Blob = class Blob {};
  sandbox.URL = { createObjectURL: () => 'blob:mock' };
  sandbox.alert = (m) => env.alerts.push(String(m));
  sandbox.confirm = (m) => { env.confirms.push(String(m)); return o.confirmAnswer !== false; };
  sandbox.log = (m, c) => env.logs.push({ msg: String(m), color: c });

  sandbox.isHttps = () => env.https;
  sandbox.isPS4 = true;
  sandbox.devMode = false;
  sandbox.webKitMin = 6.70;
  sandbox.webKitMax = 13.00;
  sandbox.projectName = 'test';
  sandbox.getScript = async () => {};
  sandbox.loadScript = async () => {};
  sandbox.chooseHEN = () => env.logs.push({ msg: 'chooseHEN()', color: 'call' });
  sandbox.cleanUp = () => {};
  sandbox.updateJbStats = () => {};
  sandbox.jailbreak = () => { env.jailbreakCalls++; };
  sandbox.chooseFanThreshold = () => env.logs.push({ msg: 'chooseFanThreshold()', color: 'call' });

  sandbox.user = {
    platform: o.platform || 'PS4',
    ip: '192.168.1.50',
    ps4Fw: o.ps4Fw !== undefined ? o.ps4Fw : 9.00,
    exploitChain: o.exploitChain !== undefined ? o.exploitChain : 1,
    currentJbFlavor: 'GoldHEN',
    bareboneJB: false,
  };

  const el = () => ({
    value: '', files: [], style: {}, innerHTML: '',
    classList: { remove() {}, add() {} },
    setAttribute() {}, appendChild() {}, click() {},
  });
  sandbox.ui = {
    ps4IpInput: el(), ps4FwSelect: el(), customPayloadInput: el(),
    toolsSection: el(), linuxSection: el(), advancedPayloadsSection: el(),
    customPayloadsSection: el(),
  };

  vm.createContext(sandbox);
  vm.runInContext(read('includes/js/languages/ar.js'), sandbox, { filename: 'ar.js' });
  vm.runInContext(read('includes/js/payloadsList.js'), sandbox, { filename: 'payloadsList.js' });
  vm.runInContext(read('includes/payloads/payloads.js'), sandbox, { filename: 'payloads.js' });
  vm.runInContext(read('includes/js/payloadsHandler.js'), sandbox, { filename: 'payloadsHandler.js' });

  // `const payloadsList` lives in the context lexical scope, not on the sandbox
  sandbox.payloadsList = vm.runInContext('payloadsList', sandbox);
  sandbox.Loadpayloads = vm.runInContext('Loadpayloads', sandbox);
  return { sandbox, env };
}

async function clickPayload(payload, opts) {
  const { sandbox, env } = buildEnv(opts);
  sandbox.sessionStorage.setItem('payload_path', 'STALE');
  try {
    sandbox.Loadpayloads(payload.funcName, payload.name, payload.id);
  } catch (e) {
    env.alerts.push('THREW: ' + e.message);
  }
  await new Promise((r) => setTimeout(r, 80));
  return { env, payloadPath: sandbox.sessionStorage.getItem('payload_path'), sandbox };
}

const kindOf = (p) => (/\.elf$/i.test(p || '') ? 'ELF' : /\.bin$/i.test(p || '') ? 'BIN' : '-');

let problems = 0;

(async () => {
  const cat = buildEnv({}).sandbox.payloadsList;

  console.log('='.repeat(100));
  console.log('SCENARIO 1 — GoldHEN PayLoader DOWN, payload files OK');
  console.log('             (the exact situation you hit: click a payload, jailbreak runs instead)');
  console.log('='.repeat(100));
  console.log('verdict  payload            file dispatched                                        type  exploit-ran');
  console.log('-'.repeat(100));
  const s1 = [];
  for (const p of cat) {
    const { env, payloadPath } = await clickPayload(p, { payLoader: 'error', fileMode: 'ok' });
    const ran = env.jailbreakCalls > 0;
    const isElfPayload = /\.elf$/i.test(payloadPath || '') ||
      ['load_Elfldr', 'load_npFakeSignin', 'load_Linux'].includes(p.funcName);
    // A .elf reaching the exploit chain = the bug.
    const bad = ran && isElfPayload;
    if (bad) problems++;
    s1.push({ p, env, payloadPath, ran, bad, isElfPayload });
    console.log(
      `${bad ? 'BUG  ' : ran ? 'jail ' : 'stop '} ${p.id.padEnd(18)} ${(payloadPath || '(none)').padEnd(52)} ` +
      `${kindOf(payloadPath).padEnd(5)} ${ran ? 'YES' : 'no'}`
    );
  }

  console.log('\n' + '='.repeat(100));
  console.log('SCENARIO 2 — GoldHEN PayLoader UP and idle');
  console.log('='.repeat(100));
  console.log('verdict  payload            file dispatched                                        type  posted-to-9090');
  console.log('-'.repeat(100));
  for (const p of cat) {
    const { env, payloadPath } = await clickPayload(p, { payLoader: 'ready', fileMode: 'ok' });
    const posted = env.posted.length > 0;
    let verdict = 'ok   ';
    if (env.fileMode === 'empty') verdict = 'BUG  ';
    console.log(
      `${verdict} ${p.id.padEnd(18)} ${(payloadPath || '(none)').padEnd(52)} ${kindOf(payloadPath).padEnd(5)} ${posted ? 'YES' : 'no'}`
    );
  }

  console.log('\n' + '='.repeat(100));
  console.log('SCENARIO 3 — payload file is EMPTY or MISSING, PayLoader DOWN');
  console.log('             (elfldr.elf and elfldr.bin really are 0 bytes in this repo)');
  console.log('='.repeat(100));
  const targets = cat.filter((p) => ['load_Elfldr', 'load_FTP', 'load_npFakeSignin', 'load_KernelDumper'].includes(p.funcName));
  for (const mode of ['empty', 'missing']) {
    console.log(`\n  fileMode = ${mode}`);
    for (const p of targets) {
      const { env } = await clickPayload(p, { payLoader: 'error', fileMode: mode });
      const ran = env.jailbreakCalls > 0;
      if (ran) problems++; // must never run the exploit when the file is unusable
      console.log(
        `    ${ran ? 'BUG (exploit ran!)' : 'correctly refused'}  ${p.id.padEnd(16)} ` +
        `alert=${env.alerts.length ? JSON.stringify(env.alerts[0]).slice(0, 72) : '(none)'}`
      );
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('SCENARIO 4 — PayLoader BUSY');
  console.log('='.repeat(100));
  for (const p of targets.slice(0, 2)) {
    const { env } = await clickPayload(p, { payLoader: 'busy', fileMode: 'ok' });
    console.log(`    ${p.id.padEnd(16)} posted=${env.posted.length} alert=${env.alerts.length ? JSON.stringify(env.alerts[0]).slice(0, 60) : '(none)'}`);
  }

  console.log('\n' + '='.repeat(100));
  console.log('SCENARIO 5 — every .elf payload must never be injected as shellcode');
  console.log('='.repeat(100));
  for (const p of cat) {
    const { env, payloadPath } = await clickPayload(p, { payLoader: 'error', fileMode: 'ok', https: true });
    if (/\.elf$/i.test(payloadPath || '')) {
      const ran = env.jailbreakCalls > 0;
      if (ran) problems++;
      console.log(`    ${ran ? 'BUG  ' : 'ok   '} ${p.id.padEnd(16)} -> ${payloadPath}  exploitRan=${ran}`);
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('SCENARIO 6 — do referenced payload files exist and look valid?');
  console.log('='.repeat(100));
  const refs = new Set();
  for (const m of read('includes/payloads/payloads.js')
    .matchAll(/["'`](\.?\/?includes\/payloads\/[^"'`]+\.(?:bin|elf))["'`]/g)) {
    refs.add(m[1].replace(/^\.\//, ''));
  }
  let emptyCount = 0, badMagic = 0;
  for (const r of [...refs].sort()) {
    const abs = path.join(ROOT, r);
    if (!fs.existsSync(abs)) { console.log(`  MISSING  ${r}`); problems++; continue; }
    const buf = fs.readFileSync(abs);
    const isELF = buf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    let tag = 'ok   ';
    if (buf.length === 0) { tag = 'EMPTY'; emptyCount++; }
    if (/\.elf$/i.test(r) && !isELF) { tag = 'BAD  '; badMagic++; }
    console.log(`  ${tag} ${String(buf.length).padStart(8)} B  ${r}${buf.length === 0 ? '   <-- 0 bytes: nothing can be loaded' : ''}`);
  }

  console.log('\n' + '='.repeat(100));
  console.log('RESULT');
  console.log('='.repeat(100));
  console.log(`  dispatch-logic problems (exploit ran instead of payload) : ${problems}`);
  console.log(`  0-byte payload files                                     : ${emptyCount}`);
  console.log(`  .elf files without ELF magic                             : ${badMagic}`);
  console.log(problems === 0
    ? '  => dispatch logic now refuses instead of silently jailbreaking.'
    : `  => ${problems} dispatch problem(s) remain.`);
})();